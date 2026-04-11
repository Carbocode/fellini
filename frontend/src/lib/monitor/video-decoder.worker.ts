/// <reference lib="webworker" />

import type { DemuxedVideoTrack, EncodedVideoSampleRecord } from "./mp4";
import type {
  DecoderAccelerationPreference,
  VideoDecoderWorkerCommand,
  VideoDecoderWorkerEvent,
} from "./video-worker-types";

const VIDEO_PREROLL_US = 500_000;
const PLAYING_HIGH_WATERMARK_US = 3_000_000;
const PAUSED_HIGH_WATERMARK_US = 1_000_000;
const MAX_DECODE_QUEUE_SIZE = 32;

let track: DemuxedVideoTrack | null = null;
let decoder: VideoDecoder | null = null;
let generation = 0;
let targetUs = 0;
let playing = false;
let selectedAcceleration: DecoderAccelerationPreference | null = null;
let sampleCursorIndex = 0;
let emittedUntilUs = 0;
let disposed = false;
let pumpPromise: Promise<void> | null = null;

async function awaitPumpIdle(): Promise<void> {
  const pendingPump = pumpPromise;
  if (!pendingPump) return;
  try {
    await pendingPump;
  } catch {
    // Pump errors are surfaced through worker messages.
  }
}

function sampleEndUs(sample: EncodedVideoSampleRecord): number {
  return sample.timestampUs + Math.max(1, sample.durationUs);
}

function findSeekStartIndex(samples: EncodedVideoSampleRecord[], targetUs: number): number {
  let fallbackIndex = 0;
  let bestIndex = -1;
  let bestTimestampUs = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample.isKeyFrame) continue;
    if (bestIndex < 0) {
      fallbackIndex = index;
    }
    if (sample.timestampUs <= targetUs && sample.timestampUs >= bestTimestampUs) {
      bestIndex = index;
      bestTimestampUs = sample.timestampUs;
    }
  }

  return bestIndex >= 0 ? bestIndex : fallbackIndex;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error ?? "Errore worker decoder");
}

function postWorkerMessage(message: VideoDecoderWorkerEvent, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

function signalError(error: unknown): void {
  postWorkerMessage({
    type: "error",
    message: describeError(error),
  });
}

async function resolveSupportedDecoderConfig(
  value: DemuxedVideoTrack,
): Promise<VideoDecoderConfig> {
  const baseConfig: VideoDecoderConfig = {
    codec: value.codec,
    codedWidth: value.codedWidth,
    codedHeight: value.codedHeight,
    description: value.description,
    optimizeForLatency: true,
  };
  const candidates: Array<{
    config: VideoDecoderConfig;
    acceleration: DecoderAccelerationPreference;
  }> = [
    {
      config: {
        ...baseConfig,
        hardwareAcceleration: "prefer-hardware",
      },
      acceleration: "prefer-hardware",
    },
    {
      config: {
        ...baseConfig,
        hardwareAcceleration: "no-preference",
      },
      acceleration: "no-preference",
    },
    {
      config: {
        ...baseConfig,
        hardwareAcceleration: "prefer-software",
      },
      acceleration: "prefer-software",
    },
  ];

  for (const candidate of candidates) {
    const support = await VideoDecoder.isConfigSupported(candidate.config);
    if (!support.supported) continue;
    selectedAcceleration = candidate.acceleration;
    return support.config ?? candidate.config;
  }

  throw new Error(`Video codec non supportato dal browser: ${value.codec}`);
}

function desiredBufferedEndUs(): number {
  return targetUs + (playing ? PLAYING_HIGH_WATERMARK_US : PAUSED_HIGH_WATERMARK_US);
}

async function configureDecoder(localGeneration: number): Promise<void> {
  if (!track) throw new Error("Track video non disponibile");
  const config = await resolveSupportedDecoderConfig(track);
  if (localGeneration !== generation || disposed) return;

  decoder?.close();
  decoder = new VideoDecoder({
    output: (frame) => {
      if (localGeneration !== generation || disposed) {
        frame.close();
        return;
      }
      const timestampUs = frame.timestamp ?? 0;
      const durationUs = Math.max(1, frame.duration ?? 0);
      emittedUntilUs = Math.max(emittedUntilUs, timestampUs + durationUs);
      const message: VideoDecoderWorkerEvent = {
        type: "frame",
        timestampUs,
        durationUs,
        frame,
      };
      postWorkerMessage(message, [frame]);
      schedulePump();
    },
    error: (error) => {
      if (localGeneration !== generation || disposed) return;
      signalError(error);
    },
  });
  decoder.addEventListener("dequeue", () => {
    if (localGeneration !== generation || disposed) return;
    schedulePump();
  });
  decoder.configure(config);
}

function shouldPumpMore(): boolean {
  if (!track || !decoder || disposed) return false;
  if (sampleCursorIndex >= track.samples.length) return false;
  if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE_SIZE) return false;
  return emittedUntilUs < desiredBufferedEndUs();
}

async function pumpDecoder(): Promise<void> {
  if (!track || !decoder || disposed) return;
  const localGeneration = generation;

  while (
    localGeneration === generation
    && sampleCursorIndex < track.samples.length
    && decoder.decodeQueueSize < MAX_DECODE_QUEUE_SIZE
    && emittedUntilUs < desiredBufferedEndUs()
  ) {
    const sample = track.samples[sampleCursorIndex];
    decoder.decode(new EncodedVideoChunk({
      type: sample.isKeyFrame ? "key" : "delta",
      timestamp: sample.timestampUs,
      duration: sample.durationUs,
      data: sample.data,
    }));
    sampleCursorIndex += 1;
  }
}

function schedulePump(): void {
  if (disposed) return;
  if (pumpPromise) return;
  pumpPromise = (async () => {
    try {
      await pumpDecoder();
    } catch (error) {
      signalError(error);
    } finally {
      pumpPromise = null;
      if (shouldPumpMore()) {
        schedulePump();
      }
    }
  })();
}

async function seekTo(nextTargetUs: number): Promise<void> {
  if (!track) throw new Error("Track video non disponibile");
  targetUs = nextTargetUs;
  generation += 1;
  await awaitPumpIdle();
  if (disposed || !track) return;
  const localGeneration = generation;
  const decodeStartUs = Math.max(0, nextTargetUs - VIDEO_PREROLL_US);
  sampleCursorIndex = findSeekStartIndex(track.samples, decodeStartUs);
  emittedUntilUs = Math.min(
    nextTargetUs,
    track.samples[sampleCursorIndex]?.timestampUs ?? nextTargetUs,
  );
  await configureDecoder(localGeneration);
  if (localGeneration !== generation || disposed) return;
  await pumpDecoder();
}

async function initialize(nextTrack: DemuxedVideoTrack, nextTargetUs: number, nextPlaying: boolean): Promise<void> {
  track = nextTrack;
  targetUs = nextTargetUs;
  playing = nextPlaying;
  await seekTo(nextTargetUs);
  postWorkerMessage({
    type: "ready",
    acceleration: selectedAcceleration,
  });
  if (shouldPumpMore()) {
    schedulePump();
  }
}

async function updateTarget(nextTargetUs: number, nextPlaying: boolean, forceSeek: boolean): Promise<void> {
  if (!track || disposed) return;
  const movedBackward = nextTargetUs < targetUs;
  targetUs = nextTargetUs;
  playing = nextPlaying;
  if (forceSeek || movedBackward) {
    await seekTo(nextTargetUs);
    return;
  }
  if (shouldPumpMore()) {
    schedulePump();
  }
}

self.onmessage = (event: MessageEvent<VideoDecoderWorkerCommand>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      void initialize(message.track, message.targetUs, message.playing).catch(signalError);
      break;
    case "update-target":
      void updateTarget(message.targetUs, message.playing, message.forceSeek).catch(signalError);
      break;
    case "dispose":
      disposed = true;
      generation += 1;
      decoder?.close();
      decoder = null;
      close();
      break;
  }
};

export {};
