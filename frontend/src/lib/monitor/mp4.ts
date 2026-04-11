import { DataStream, createFile, type MP4BoxBuffer } from "mp4box";

export interface EncodedVideoSampleRecord {
  timestampUs: number;
  durationUs: number;
  isKeyFrame: boolean;
  data: Uint8Array;
}

export interface EncodedAudioSampleRecord {
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export interface DemuxedVideoTrack {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Uint8Array;
  samples: EncodedVideoSampleRecord[];
}

export interface DemuxedAudioTrack {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description: Uint8Array | null;
  samples: EncodedAudioSampleRecord[];
}

export interface DemuxedMp4Asset {
  url: string;
  durationSeconds: number;
  video: DemuxedVideoTrack | null;
  audio: DemuxedAudioTrack | null;
}

type Mp4InfoTrack = {
  id: number;
  type: string;
  codec: string;
  nb_samples: number;
  video?: { width: number; height: number };
  audio?: { sample_rate: number; channel_count: number };
};

type Mp4Info = {
  duration: number;
  timescale: number;
  tracks: Mp4InfoTrack[];
};

type Mp4Sample = {
  number: number;
  description?: {
    avcC?: { hdr_size?: number; write: (stream: DataStream) => void };
    esds?: {
      esd?: {
        descs?: Array<{
          descs?: Array<{ tag?: number; data?: ArrayLike<number> }>;
        }>;
      };
    };
  };
  is_sync?: boolean;
  dts: number;
  cts: number;
  duration: number;
  timescale: number;
  data: ArrayBuffer | Uint8Array;
};

type TrackAccumulator = {
  track: Mp4InfoTrack;
  video?: DemuxedVideoTrack | null;
  audio?: DemuxedAudioTrack | null;
  done: boolean;
};

function cloneBytes(bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return Uint8Array.from(bytes);
}

function secondsToMicroseconds(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

function mp4TimeToMicroseconds(value: number, timescale: number): number {
  if (!timescale) return 0;
  return secondsToMicroseconds(value / timescale);
}

function serializeBoxPayload(box: { hdr_size?: number; write: (stream: DataStream) => void }): Uint8Array {
  const stream = new DataStream();
  box.write(stream);
  const full = new Uint8Array(stream.buffer.slice(0));
  const offset = box.hdr_size ?? 8;
  return full.slice(offset);
}

function extractAacDescription(sample: Mp4Sample): Uint8Array | null {
  const descriptor = sample.description?.esds?.esd?.descs
    ?.flatMap((item) => item.descs ?? [])
    .find((item) => item.tag === 5);
  return descriptor?.data ? Uint8Array.from(descriptor.data) : null;
}

function buildVideoTrack(track: Mp4InfoTrack, sample: Mp4Sample): DemuxedVideoTrack {
  if (!sample.description?.avcC) {
    throw new Error("Monitor v1 richiede tracce H.264 con avcC");
  }
  return {
    codec: track.codec,
    codedWidth: Math.max(1, Math.round(track.video?.width ?? 1)),
    codedHeight: Math.max(1, Math.round(track.video?.height ?? 1)),
    description: serializeBoxPayload(sample.description.avcC),
    samples: [],
  };
}

function buildAudioTrack(track: Mp4InfoTrack, sample: Mp4Sample): DemuxedAudioTrack {
  return {
    codec: track.codec,
    sampleRate: Math.max(1, Math.round(track.audio?.sample_rate ?? 48_000)),
    numberOfChannels: Math.max(1, Math.round(track.audio?.channel_count ?? 2)),
    description: extractAacDescription(sample),
    samples: [],
  };
}

function assertSupportedTracks(info: Mp4Info): void {
  for (const track of info.tracks) {
    if (track.type === "video" && !/^(avc1|avc3)\./.test(track.codec)) {
      throw new Error(`Monitor v1 supporta solo video H.264 MP4, trovato ${track.codec}`);
    }
    if (track.type === "audio" && !/^mp4a\./.test(track.codec)) {
      throw new Error(`Monitor v1 supporta solo audio AAC/mp4a, trovato ${track.codec}`);
    }
  }
}

export async function demuxMp4Asset(url: string): Promise<DemuxedMp4Asset> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Impossibile caricare il media monitor: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();

  return await new Promise<DemuxedMp4Asset>((resolve, reject) => {
    const mp4 = createFile();
    const trackStates = new Map<number, TrackAccumulator>();
    let readyInfo: Mp4Info | null = null;
    let settled = false;

    const maybeResolve = () => {
      if (settled || !readyInfo) return;
      if ([...trackStates.values()].some((state) => !state.done)) return;
      settled = true;
      resolve({
        url,
        durationSeconds: readyInfo.timescale > 0 ? (readyInfo.duration / readyInfo.timescale) : 0,
        video: [...trackStates.values()].find((state) => state.track.type === "video")?.video ?? null,
        audio: [...trackStates.values()].find((state) => state.track.type === "audio")?.audio ?? null,
      });
    };

    mp4.onError = (_module, message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    mp4.onReady = (info) => {
      try {
        readyInfo = info as Mp4Info;
        assertSupportedTracks(readyInfo);
        for (const track of readyInfo.tracks) {
          if (track.type !== "video" && track.type !== "audio") continue;
          trackStates.set(track.id, { track, done: track.nb_samples === 0 });
          mp4.setExtractionOptions(track.id, track.id, { nbSamples: Math.max(1, track.nb_samples) });
        }
        if (!trackStates.size) {
          settled = true;
          resolve({
            url,
            durationSeconds: readyInfo.timescale > 0 ? (readyInfo.duration / readyInfo.timescale) : 0,
            video: null,
            audio: null,
          });
          return;
        }
        mp4.start();
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error("Parsing MP4 fallito"));
      }
    };

    mp4.onSamples = (trackId, _user, samples) => {
      if (settled) return;
      const state = trackStates.get(trackId);
      if (!state || !samples.length) {
        maybeResolve();
        return;
      }
      try {
        for (const sample of (samples as unknown as Mp4Sample[])) {
          if (state.track.type === "video") {
            state.video ??= buildVideoTrack(state.track, sample);
            state.video.samples.push({
              timestampUs: mp4TimeToMicroseconds(sample.cts, sample.timescale),
              durationUs: mp4TimeToMicroseconds(sample.duration, sample.timescale),
              isKeyFrame: !!sample.is_sync,
              data: cloneBytes(sample.data),
            });
          } else if (state.track.type === "audio") {
            state.audio ??= buildAudioTrack(state.track, sample);
            state.audio.samples.push({
              timestampUs: mp4TimeToMicroseconds(sample.cts, sample.timescale),
              durationUs: mp4TimeToMicroseconds(sample.duration, sample.timescale),
              data: cloneBytes(sample.data),
            });
          }
          if (sample.number >= (state.track.nb_samples - 1)) {
            state.done = true;
          }
        }
        maybeResolve();
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error("Estrazione sample MP4 fallita"));
      }
    };

    const mp4Buffer = buffer.slice(0) as MP4BoxBuffer;
    mp4Buffer.fileStart = 0;
    mp4.appendBuffer(mp4Buffer);
    mp4.flush();
  });
}
