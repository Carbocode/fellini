import type { DemuxedVideoTrack } from "./mp4";
import type {
  DecoderAccelerationPreference,
  VideoDecodeIntent,
  VideoDecoderWorkerCommand,
  VideoDecoderWorkerEvent,
} from "./video-worker-types";

const VIDEO_RETAIN_BEFORE_US = 1_000_000;
const WORKER_TARGET_EPSILON_US = 25_000;
const FRAME_WAIT_TIMEOUT_MS = 4_000;

type CachedVideoFrame = {
  timestampUs: number;
  durationUs: number;
  frame: VideoFrame;
};

type FrameWaiter = {
  targetUs: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

function cachedFrameEndUs(frame: CachedVideoFrame): number {
  return frame.timestampUs + Math.max(1, frame.durationUs);
}

export type VideoClipPlayerDebugState = {
  workerReady: boolean;
  destroyed: boolean;
  decodedFrames: number;
  bufferedFrames: number;
  bufferedRangeStartUs: number | null;
  bufferedRangeEndUs: number | null;
  firstFrameTimestampUs: number | null;
  lastFrameTimestampUs: number | null;
  selectedAcceleration: DecoderAccelerationPreference | null;
  lastDispatchedTargetUs: number | null;
  lastDispatchedPlaying: boolean | null;
  lastRequestedTargetUs: number | null;
  lastRequestedPlaying: boolean | null;
  lastRequestedIntent: VideoDecodeIntent | null;
  lastNeedsSeek: boolean;
  lastForceSeek: boolean;
  lastHadFrameAtTarget: boolean;
  lastResumeRequiresSeek: boolean;
  activeSessionToken: number;
  pendingSessionToken: number | null;
  pendingWaiters: number;
  lastError: string | null;
};

export class VideoClipPlayer {
  private worker: Worker | null = null;
  private workerReady = false;
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private frames: CachedVideoFrame[] = [];
  private waiters: FrameWaiter[] = [];
  private decodedFrameCount = 0;
  private selectedAcceleration: DecoderAccelerationPreference | null = null;
  private lastError: Error | null = null;
  private lastDispatchedTargetUs: number | null = null;
  private lastDispatchedPlaying: boolean | null = null;
  private lastRequestedTargetUs: number | null = null;
  private lastRequestedPlaying: boolean | null = null;
  private lastRequestedIntent: VideoDecodeIntent | null = null;
  private lastNeedsSeek = false;
  private lastForceSeek = false;
  private lastHadFrameAtTarget = false;
  private lastResumeRequiresSeek = false;
  private destroyed = false;

  constructor(
    private readonly track: DemuxedVideoTrack,
    private readonly onFrameAvailable: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  private clearFrames(): void {
    for (const cached of this.frames) cached.frame.close();
    this.frames = [];
  }

  private clearWaiters(error?: Error): void {
    for (const waiter of this.waiters) {
      window.clearTimeout(waiter.timeoutId);
      if (error) waiter.reject(error);
    }
    this.waiters = [];
  }

  private insertFrame(frame: VideoFrame): void {
    this.decodedFrameCount += 1;
    const cached: CachedVideoFrame = {
      timestampUs: frame.timestamp ?? 0,
      durationUs: Math.max(1, frame.duration ?? 0),
      frame,
    };
    const existingIndex = this.frames.findIndex((item) => item.timestampUs === cached.timestampUs);
    if (existingIndex >= 0) {
      this.frames[existingIndex].frame.close();
      this.frames[existingIndex] = cached;
    } else {
      this.frames.push(cached);
      this.frames.sort((left, right) => left.timestampUs - right.timestampUs);
    }
    this.resolveWaiters();
  }

  private evictFramesBefore(cutoffUs: number): void {
    const keep: CachedVideoFrame[] = [];
    for (const cached of this.frames) {
      if (cachedFrameEndUs(cached) < cutoffUs) {
        cached.frame.close();
      } else {
        keep.push(cached);
      }
    }
    this.frames = keep;
  }

  private findFrameAt(targetUs: number): VideoFrame | null {
    if (!this.frames.length) return null;
    for (const cached of this.frames) {
      const frameEnd = cachedFrameEndUs(cached);
      if (cached.timestampUs <= targetUs && targetUs < frameEnd) {
        return cached.frame;
      }
    }
    const previous = [...this.frames].reverse().find((cached) => cached.timestampUs <= targetUs);
    if (previous) return previous.frame;
    return this.frames[0]?.frame ?? null;
  }

  private bufferedRangeUs(): { startUs: number; endUs: number } | null {
    if (!this.frames.length) return null;
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    return {
      startUs: first.timestampUs,
      endUs: cachedFrameEndUs(last),
    };
  }

  private resolveWaiters(): void {
    const nextWaiters: FrameWaiter[] = [];
    for (const waiter of this.waiters) {
      if (this.findFrameAt(waiter.targetUs)) {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve();
      } else {
        nextWaiters.push(waiter);
      }
    }
    this.waiters = nextWaiters;
  }

  private fail(error: Error): void {
    if (this.destroyed) return;
    this.lastError = error;
    this.onError(error);
    this.initReject?.(error);
    this.initPromise = null;
    this.initResolve = null;
    this.initReject = null;
    this.clearWaiters(error);
  }

  private handleWorkerMessage(event: MessageEvent<VideoDecoderWorkerEvent>): void {
    const message = event.data;
    switch (message.type) {
      case "ready":
        this.workerReady = true;
        this.selectedAcceleration = message.acceleration;
        this.initResolve?.();
        this.initPromise = null;
        this.initResolve = null;
        this.initReject = null;
        return;
      case "frame":
        this.insertFrame(message.frame);
        this.onFrameAvailable();
        return;
      case "error":
        this.fail(new Error(message.message));
        return;
    }
  }

  private handleWorkerFailure(reason: unknown): void {
    const error = reason instanceof Error
      ? reason
      : new Error(String(reason ?? "Errore worker video"));
    this.fail(error);
  }

  private ensureWorker(targetUs: number, playing: boolean): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error("VideoClipPlayer distrutto"));
    }
    if (this.workerReady && this.worker) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.worker = new Worker(
      new URL("./video-decoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event) => this.handleWorkerMessage(event as MessageEvent<VideoDecoderWorkerEvent>);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.handleWorkerFailure(event.error ?? event.message);
    };
    this.worker.onmessageerror = (event) => {
      event.preventDefault();
      this.handleWorkerFailure("Messaggio worker video non valido");
    };

    this.initPromise = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });

    const initMessage: VideoDecoderWorkerCommand = {
      type: "init",
      track: this.track,
      targetUs,
      playing,
    };
    this.worker.postMessage(initMessage);
    this.lastDispatchedTargetUs = targetUs;
    this.lastDispatchedPlaying = playing;
    return this.initPromise;
  }

  private dispatchTarget(targetUs: number, playing: boolean, forceSeek: boolean): void {
    if (!this.worker) return;
    const targetChanged = this.lastDispatchedTargetUs === null
      || Math.abs(this.lastDispatchedTargetUs - targetUs) >= WORKER_TARGET_EPSILON_US;
    const playingChanged = this.lastDispatchedPlaying !== playing;
    if (!forceSeek && !targetChanged && !playingChanged) return;
    const message: VideoDecoderWorkerCommand = {
      type: "update-target",
      targetUs,
      playing,
      forceSeek,
    };
    this.worker.postMessage(message);
    this.lastDispatchedTargetUs = targetUs;
    this.lastDispatchedPlaying = playing;
  }

  private waitForFrameAt(targetUs: number): Promise<void> {
    if (this.findFrameAt(targetUs)) return Promise.resolve();
    if (this.lastError) return Promise.reject(this.lastError);
    return new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item.timeoutId !== timeoutId);
        reject(new Error("Timeout attesa frame video"));
      }, FRAME_WAIT_TIMEOUT_MS);
      this.waiters.push({
        targetUs,
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  getFrameAtTime(targetUs: number): VideoFrame | null {
    return this.findFrameAt(targetUs);
  }

  getStats(): { decodedFrames: number; bufferedFrames: number } {
    return {
      decodedFrames: this.decodedFrameCount,
      bufferedFrames: this.frames.length,
    };
  }

  getAccelerationPreference(): DecoderAccelerationPreference | null {
    return this.selectedAcceleration;
  }

  getDebugState(): VideoClipPlayerDebugState {
    const bufferedRange = this.bufferedRangeUs();
    return {
      workerReady: this.workerReady,
      destroyed: this.destroyed,
      decodedFrames: this.decodedFrameCount,
      bufferedFrames: this.frames.length,
      bufferedRangeStartUs: bufferedRange?.startUs ?? null,
      bufferedRangeEndUs: bufferedRange?.endUs ?? null,
      firstFrameTimestampUs: this.frames[0]?.timestampUs ?? null,
      lastFrameTimestampUs: this.frames[this.frames.length - 1]?.timestampUs ?? null,
      selectedAcceleration: this.selectedAcceleration,
      lastDispatchedTargetUs: this.lastDispatchedTargetUs,
      lastDispatchedPlaying: this.lastDispatchedPlaying,
      lastRequestedTargetUs: this.lastRequestedTargetUs,
      lastRequestedPlaying: this.lastRequestedPlaying,
      lastRequestedIntent: this.lastRequestedIntent,
      lastNeedsSeek: this.lastNeedsSeek,
      lastForceSeek: this.lastForceSeek,
      lastHadFrameAtTarget: this.lastHadFrameAtTarget,
      lastResumeRequiresSeek: this.lastResumeRequiresSeek,
      activeSessionToken: 1,
      pendingSessionToken: null,
      pendingWaiters: this.waiters.length,
      lastError: this.lastError?.message ?? null,
    };
  }

  async ensureWindow(targetUs: number, playing: boolean): Promise<void> {
    await this.ensureWorker(targetUs, playing);
    const bufferedRange = this.bufferedRangeUs();
    const frameAtTarget = this.findFrameAt(targetUs);
    const needsSeek = !!bufferedRange && (
      ((targetUs < bufferedRange.startUs) && !frameAtTarget)
      || (!playing && targetUs > bufferedRange.endUs)
    );

    this.dispatchTarget(targetUs, playing, needsSeek);
    this.evictFramesBefore(targetUs - VIDEO_RETAIN_BEFORE_US);

    if (needsSeek || !frameAtTarget) {
      await this.waitForFrameAt(targetUs);
    }
  }

  async requestFrame(
    targetUs: number,
    options: {
      playing: boolean;
      intent: VideoDecodeIntent;
      blocking: boolean;
    },
  ): Promise<void> {
    this.lastRequestedTargetUs = targetUs;
    this.lastRequestedPlaying = options.playing;
    this.lastRequestedIntent = options.intent;
    this.lastResumeRequiresSeek = options.intent === "play-start";

    const bufferedRange = this.bufferedRangeUs();
    const frameAtTarget = this.findFrameAt(targetUs);
    const needsSeek = !!bufferedRange && (
      ((targetUs < bufferedRange.startUs) && !frameAtTarget)
      || (!options.playing && targetUs > bufferedRange.endUs)
    );

    this.lastNeedsSeek = needsSeek;
    this.lastForceSeek = needsSeek;
    this.lastHadFrameAtTarget = !!frameAtTarget;

    await this.ensureWindow(targetUs, options.playing);

    if (options.blocking && !this.findFrameAt(targetUs)) {
      await this.waitForFrameAt(targetUs);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.clearWaiters(new Error("VideoClipPlayer distrutto"));
    this.clearFrames();
    if (this.worker) {
      const message: VideoDecoderWorkerCommand = { type: "dispose" };
      try {
        this.worker.postMessage(message);
      } catch {
        // Ignore worker disposal race.
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.workerReady = false;
    this.initPromise = null;
    this.initResolve = null;
    this.initReject = null;
  }
}

export type { VideoDecodeIntent };
