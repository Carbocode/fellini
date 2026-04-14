import {
  EncodedPacketSink,
  Input,
  MP4,
  QTFF,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
} from "mediabunny";

export interface EncodedVideoSampleRecord {
  timestampUs: number;
  durationUs: number;
  sequenceNumber: number;
  isKeyFrame: boolean;
  data: Uint8Array;
}

export interface EncodedAudioSampleRecord {
  timestampUs: number;
  durationUs: number;
  sequenceNumber: number;
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

function cloneBytes(bytes: AllowSharedBufferSource | ArrayBufferView | Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes.slice(0));
  }
  if (typeof SharedArrayBuffer !== "undefined" && bytes instanceof SharedArrayBuffer) {
    return new Uint8Array(bytes.slice(0));
  }
  return new Uint8Array(bytes.slice(0));
}

function normalizeDurationUs(durationUs: number): number {
  return Math.max(1, durationUs);
}

function assertSupportedVideoConfig(
  track: InputVideoTrack,
  config: VideoDecoderConfig | null,
): asserts config is VideoDecoderConfig & { codec: string; description: AllowSharedBufferSource } {
  if (!config?.codec || !/^(avc1|avc3)\./.test(config.codec)) {
    throw new Error(`Monitor v1 supporta solo video H.264 MP4/MOV, trovato ${config?.codec ?? track.codec ?? "unknown"}`);
  }
  if (!config.description) {
    throw new Error("Monitor v1 richiede tracce H.264 con decoder description AVCC");
  }
}

function assertSupportedAudioConfig(
  track: InputAudioTrack,
  config: AudioDecoderConfig | null,
): asserts config is AudioDecoderConfig & { codec: string } {
  if (!config?.codec || !/^mp4a\./.test(config.codec)) {
    throw new Error(`Monitor v1 supporta solo audio AAC/mp4a, trovato ${config?.codec ?? track.codec ?? "unknown"}`);
  }
}

async function collectVerifiedKeyframes(track: InputVideoTrack): Promise<Set<number>> {
  const sink = new EncodedPacketSink(track);
  const verified = new Set<number>();

  let packet = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
  while (packet) {
    if (packet.sequenceNumber >= 0) verified.add(packet.sequenceNumber);
    packet = await sink.getNextKeyPacket(packet, { verifyKeyPackets: true });
  }

  return verified;
}

async function collectVideoTrack(track: InputVideoTrack): Promise<DemuxedVideoTrack> {
  const decoderConfig = await track.getDecoderConfig();
  assertSupportedVideoConfig(track, decoderConfig);

  const verifiedKeyframes = await collectVerifiedKeyframes(track);
  const samples: EncodedVideoSampleRecord[] = [];
  const sink = new EncodedPacketSink(track);

  for await (const packet of sink.packets()) {
    samples.push({
      timestampUs: packet.microsecondTimestamp,
      durationUs: normalizeDurationUs(packet.microsecondDuration),
      sequenceNumber: packet.sequenceNumber,
      isKeyFrame: packet.sequenceNumber >= 0
        ? verifiedKeyframes.has(packet.sequenceNumber)
        : packet.type === "key",
      data: cloneBytes(packet.data),
    });
  }

  return {
    codec: decoderConfig.codec,
    codedWidth: Math.max(1, Math.round(track.codedWidth || 1)),
    codedHeight: Math.max(1, Math.round(track.codedHeight || 1)),
    description: cloneBytes(decoderConfig.description),
    samples,
  };
}

async function collectAudioTrack(track: InputAudioTrack): Promise<DemuxedAudioTrack> {
  const decoderConfig = await track.getDecoderConfig();
  assertSupportedAudioConfig(track, decoderConfig);

  const samples: EncodedAudioSampleRecord[] = [];
  const sink = new EncodedPacketSink(track);

  for await (const packet of sink.packets()) {
    samples.push({
      timestampUs: packet.microsecondTimestamp,
      durationUs: normalizeDurationUs(packet.microsecondDuration),
      sequenceNumber: packet.sequenceNumber,
      data: cloneBytes(packet.data),
    });
  }

  return {
    codec: decoderConfig.codec,
    sampleRate: Math.max(1, Math.round(track.sampleRate || 48_000)),
    numberOfChannels: Math.max(1, Math.round(track.numberOfChannels || 2)),
    description: decoderConfig.description ? cloneBytes(decoderConfig.description) : null,
    samples,
  };
}

export async function demuxMp4Asset(url: string): Promise<DemuxedMp4Asset> {
  const input = new Input({
    source: new UrlSource(url, {
      requestInit: { cache: "force-cache" },
    }),
    formats: [MP4, QTFF],
  });

  try {
    const [durationSeconds, videoTrack, audioTrack] = await Promise.all([
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);

    const [video, audio] = await Promise.all([
      videoTrack ? collectVideoTrack(videoTrack) : Promise.resolve(null),
      audioTrack ? collectAudioTrack(audioTrack) : Promise.resolve(null),
    ]);

    return {
      url,
      durationSeconds: Math.max(0, durationSeconds),
      video,
      audio,
    };
  } finally {
    input.dispose();
  }
}
