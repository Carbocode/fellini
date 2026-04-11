import {
  activeVideoLayersAtTime,
  audioClipsStartingFrom,
  clipLocalTime,
  type MonitorComposition,
  type MonitorVideoLayer,
} from "./composition";
import { decodeAudioTrackToAudioBuffer, MonitorAudioTransport } from "./audio";
import { demuxMp4Asset, type DemuxedMp4Asset } from "./mp4";
import { MonitorWebGpuRenderer, type RenderVideoLayer } from "./renderer";
import { VideoClipPlayer } from "./video";

type MonitorStatus = "ready" | "unsupported";

export type MonitorDiagnostics = {
  renderer: "webgpu";
  currentTime: number;
  activeLayers: number;
  renderedLayers: number;
  decodedFrames: number;
  bufferedFrames: number;
  lastError: string | null;
};

type RuntimeCallbacks = {
  onTimeUpdate: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onGpuStatus: (status: MonitorStatus) => void;
  onCodecStatus: (status: MonitorStatus) => void;
  onDiagnostics?: (diagnostics: MonitorDiagnostics) => void;
  onError?: (error: Error) => void;
};

type MediaUrlResolver = (mediaPath: string) => string | null;

function isPromiseLike<T>(value: Promise<T> | T): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function secondsToMicroseconds(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function playerKeyForLayer(layer: MonitorVideoLayer): string {
  return `${layer.clipId}:${layer.mediaPath}`;
}

export class CanvasMonitorRuntime {
  private readonly renderer: MonitorWebGpuRenderer;
  private readonly audioTransport: MonitorAudioTransport;
  private composition: MonitorComposition | null = null;
  private resolveMediaUrl: MediaUrlResolver = () => null;
  private demuxCache = new Map<string, Promise<DemuxedMp4Asset> | DemuxedMp4Asset>();
  private audioBufferCache = new Map<string, Promise<AudioBuffer | null> | AudioBuffer | null>();
  private videoPlayers = new Map<string, Promise<VideoClipPlayer | null> | VideoClipPlayer | null>();
  private playing = false;
  private currentTime = 0;
  private raf = 0;
  private renderQueued = false;
  private rendering = false;
  private renderDrainPromise: Promise<void> | null = null;
  private pendingRender: { time: number; blocking: boolean } | null = null;
  private initialized = false;
  private destroyed = false;
  private lastErrorMessage: string | null = null;
  private lastDiagnosticsSnapshot: Omit<MonitorDiagnostics, "renderer" | "lastError"> = {
    currentTime: 0,
    activeLayers: 0,
    renderedLayers: 0,
    decodedFrames: 0,
    bufferedFrames: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly callbacks: RuntimeCallbacks,
  ) {
    this.renderer = new MonitorWebGpuRenderer(canvas, (error) => this.reportError(error));
    this.audioTransport = new MonitorAudioTransport(
      () => this.composition?.sequence.sampleRate ?? 48_000,
      (mediaPath) => this.getAudioBuffer(mediaPath),
    );
    this.publishCapabilityStatus();
    this.publishDiagnostics({
      currentTime: 0,
      activeLayers: 0,
      renderedLayers: 0,
      decodedFrames: 0,
      bufferedFrames: 0,
    });
  }

  private publishCapabilityStatus(): void {
    const gpuReady = !!((navigator as Navigator & { gpu?: unknown }).gpu);
    const codecsReady = ("VideoDecoder" in window) && ("AudioDecoder" in window);
    this.callbacks.onGpuStatus(gpuReady ? "ready" : "unsupported");
    this.callbacks.onCodecStatus(codecsReady ? "ready" : "unsupported");
  }

  private publishDiagnostics(
    partial: Omit<MonitorDiagnostics, "renderer" | "lastError">,
  ): void {
    this.lastDiagnosticsSnapshot = partial;
    this.callbacks.onDiagnostics?.({
      renderer: "webgpu",
      lastError: this.lastErrorMessage,
      ...partial,
    });
  }

  private reportError(error: Error): void {
    this.lastErrorMessage = error.message;
    this.callbacks.onError?.(error);
    this.publishDiagnostics({
      ...this.lastDiagnosticsSnapshot,
    });
  }

  private async ensureRenderer(): Promise<boolean> {
    if (this.destroyed || !this.composition) return false;
    const gpuReady = !!((navigator as Navigator & { gpu?: unknown }).gpu);
    const codecsReady = ("VideoDecoder" in window) && ("AudioDecoder" in window);
    if (!gpuReady || !codecsReady) return false;
    if (!this.initialized) {
      try {
        await this.renderer.initialize(this.composition.sequence);
        this.initialized = true;
      } catch (error) {
        this.initialized = false;
        this.callbacks.onGpuStatus("unsupported");
        this.reportError(error instanceof Error ? error : new Error("Init renderer fallita"));
        return false;
      }
    } else {
      this.renderer.resize(this.composition.sequence);
    }
    return true;
  }

  private ensureDemuxed(mediaPath: string): Promise<DemuxedMp4Asset> {
    const mediaUrl = this.resolveMediaUrl(mediaPath);
    if (!mediaUrl) return Promise.reject(new Error(`Media non risolto: ${mediaPath}`));
    const cached = this.demuxCache.get(mediaUrl);
    if (cached) return isPromiseLike(cached) ? cached : Promise.resolve(cached);
    const pending = demuxMp4Asset(mediaUrl)
      .then((asset) => {
        this.demuxCache.set(mediaUrl, asset);
        return asset;
      })
      .catch((error) => {
        this.demuxCache.delete(mediaUrl);
        throw error;
      });
    this.demuxCache.set(mediaUrl, pending);
    return pending;
  }

  private getAudioBuffer(mediaPath: string): Promise<AudioBuffer | null> {
    const mediaUrl = this.resolveMediaUrl(mediaPath);
    if (!mediaUrl) return Promise.resolve(null);
    const cached = this.audioBufferCache.get(mediaUrl);
    if (cached !== undefined) {
      return isPromiseLike(cached) ? cached : Promise.resolve(cached);
    }
    const pending = this.ensureDemuxed(mediaPath)
      .then((asset) => (
        asset.audio ? decodeAudioTrackToAudioBuffer(asset.audio) : null
      ))
      .then((buffer) => {
        this.audioBufferCache.set(mediaUrl, buffer);
        return buffer;
      })
      .catch((error) => {
        this.audioBufferCache.delete(mediaUrl);
        this.reportError(error instanceof Error ? error : new Error("Decode audio fallita"));
        return null;
      });
    this.audioBufferCache.set(mediaUrl, pending);
    return pending;
  }

  private getVideoPlayer(layer: MonitorVideoLayer): Promise<VideoClipPlayer | null> {
    const key = playerKeyForLayer(layer);
    const cached = this.videoPlayers.get(key);
    if (cached !== undefined) {
      return isPromiseLike(cached) ? cached : Promise.resolve(cached);
    }
    const pending = this.ensureDemuxed(layer.mediaPath)
      .then((asset) => {
        if (!asset.video) return null;
        const player = new VideoClipPlayer(
          asset.video,
          () => this.requestRender(),
          (error) => this.reportError(error),
        );
        this.videoPlayers.set(key, player);
        return player;
      })
      .catch((error) => {
        this.videoPlayers.delete(key);
        this.reportError(error instanceof Error ? error : new Error("Init player video fallita"));
        return null;
      });
    this.videoPlayers.set(key, pending);
    return pending;
  }

  private async reconcileVideoPlayers(): Promise<void> {
    if (!this.composition) return;
    const wantedKeys = new Set(this.composition.videoLayers.map(playerKeyForLayer));
    for (const [key, value] of this.videoPlayers.entries()) {
      if (wantedKeys.has(key)) continue;
      this.videoPlayers.delete(key);
      if (!isPromiseLike(value) && value) {
        await value.destroy().catch(() => {});
      }
    }
  }

  private async preloadAssets(): Promise<void> {
    if (!this.composition) return;
    const uniqueMediaPaths = new Set([
      ...this.composition.videoLayers.map((layer) => layer.mediaPath),
      ...this.composition.audioClips.map((clip) => clip.mediaPath),
    ]);
    for (const mediaPath of uniqueMediaPaths) {
      void this.ensureDemuxed(mediaPath).catch((error) => {
        this.reportError(error instanceof Error ? error : new Error("Preload media fallita"));
      });
    }
    for (const mediaPath of new Set(this.composition.audioClips.map((clip) => clip.mediaPath))) {
      void this.getAudioBuffer(mediaPath);
    }
  }

  private stopLoop(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private startLoop(): void {
    if (this.raf || !this.playing) return;
    const step = () => {
      this.raf = 0;
      if (!this.playing || !this.composition) return;
      this.currentTime = clamp(this.audioTransport.getCurrentTime(), 0, this.composition.duration);
      this.callbacks.onTimeUpdate(this.currentTime);
      if (this.currentTime >= this.composition.duration) {
        void this.pause();
        return;
      }
      void this.queueRender(this.currentTime, false);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private requestRender(): void {
    if (this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      void this.queueRender(this.currentTime, false);
    });
  }

  private async buildRenderLayers(
    time: number,
    blocking: boolean,
  ): Promise<{
    activeLayerCount: number;
    decodedFrameCount: number;
    bufferedFrameCount: number;
    renderLayers: RenderVideoLayer[];
  }> {
    if (!this.composition) {
      return {
        activeLayerCount: 0,
        decodedFrameCount: 0,
        bufferedFrameCount: 0,
        renderLayers: [],
      };
    }
    const activeLayers = activeVideoLayersAtTime(this.composition, time);
    const renderLayers: RenderVideoLayer[] = [];
    let decodedFrameCount = 0;
    let bufferedFrameCount = 0;
    for (const layer of activeLayers) {
      const player = await this.getVideoPlayer(layer);
      if (!player) continue;
      const localTimeUs = secondsToMicroseconds(clipLocalTime(layer, time));
      if (blocking) {
        await player.ensureWindow(localTimeUs, this.playing).catch((error) => {
          this.reportError(error instanceof Error ? error : new Error("Decode video fallita"));
        });
      } else {
        void player.ensureWindow(localTimeUs, this.playing).catch((error) => {
          this.reportError(error instanceof Error ? error : new Error("Decode video fallita"));
        });
      }
      const stats = player.getStats();
      decodedFrameCount += stats.decodedFrames;
      bufferedFrameCount += stats.bufferedFrames;
      const frame = player.getFrameAtTime(localTimeUs);
      if (frame) renderLayers.push({ spec: layer, frame });
    }
    return {
      activeLayerCount: activeLayers.length,
      decodedFrameCount,
      bufferedFrameCount,
      renderLayers,
    };
  }

  private async renderAtTime(time: number, blocking: boolean): Promise<void> {
    if (!this.composition) return;
    const ready = await this.ensureRenderer();
    if (!ready) {
      this.publishDiagnostics({
        currentTime: time,
        activeLayers: 0,
        renderedLayers: 0,
        decodedFrames: 0,
        bufferedFrames: 0,
      });
      return;
    }
    const result = await this.buildRenderLayers(time, blocking);
    this.renderer.render(this.composition.sequence, result.renderLayers);
    this.publishDiagnostics({
      currentTime: time,
      activeLayers: result.activeLayerCount,
      renderedLayers: result.renderLayers.length,
      decodedFrames: result.decodedFrameCount,
      bufferedFrames: result.bufferedFrameCount,
    });
  }

  private queueRender(time: number, blocking: boolean): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    const request = { time, blocking };
    if (this.rendering) {
      this.pendingRender = this.pendingRender
        ? {
          time,
          blocking: this.pendingRender.blocking || blocking,
        }
        : request;
      return this.renderDrainPromise ?? Promise.resolve();
    }

    this.rendering = true;
    this.renderDrainPromise = (async () => {
      let nextRequest: { time: number; blocking: boolean } | null = request;
      while (nextRequest && !this.destroyed) {
        const currentRequest = nextRequest;
        nextRequest = null;
        await this.renderAtTime(currentRequest.time, currentRequest.blocking);
        if (this.pendingRender) {
          nextRequest = this.pendingRender;
          this.pendingRender = null;
        }
      }
    })().finally(() => {
      this.rendering = false;
      this.renderDrainPromise = null;
      this.pendingRender = null;
    });

    return this.renderDrainPromise;
  }

  getCurrentTime(): number {
    return this.playing ? this.audioTransport.getCurrentTime() : this.currentTime;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async setComposition(composition: MonitorComposition | null, resolveMediaUrl: MediaUrlResolver): Promise<void> {
    this.resolveMediaUrl = resolveMediaUrl;
    this.composition = composition;
    this.publishCapabilityStatus();
    if (!composition) {
      this.currentTime = 0;
      this.stopLoop();
      await this.audioTransport.pause().catch(() => {});
      this.playing = false;
      this.callbacks.onPlayingChange(false);
      this.publishDiagnostics({
        currentTime: 0,
        activeLayers: 0,
        renderedLayers: 0,
        decodedFrames: 0,
        bufferedFrames: 0,
      });
      return;
    }
    this.currentTime = clamp(this.currentTime, 0, composition.duration);
    await this.reconcileVideoPlayers();
    void this.preloadAssets();
    if (this.playing) {
      await this.audioTransport.seek(this.currentTime, audioClipsStartingFrom(composition, this.currentTime), composition.duration);
    }
    await this.queueRender(this.currentTime, true);
  }

  async play(): Promise<void> {
    if (!this.composition || this.playing) return;
    const ready = await this.ensureRenderer();
    if (!ready) return;
    this.currentTime = clamp(this.currentTime, 0, this.composition.duration);
    await this.queueRender(this.currentTime, true);
    await this.audioTransport.play(
      audioClipsStartingFrom(this.composition, this.currentTime),
      this.currentTime,
      this.composition.duration,
    );
    this.playing = true;
    this.callbacks.onPlayingChange(true);
    this.startLoop();
  }

  async pause(): Promise<void> {
    if (!this.playing) return;
    this.currentTime = this.composition
      ? clamp(await this.audioTransport.pause(), 0, this.composition.duration)
      : await this.audioTransport.pause();
    this.playing = false;
    this.stopLoop();
    this.callbacks.onPlayingChange(false);
    this.callbacks.onTimeUpdate(this.currentTime);
    await this.queueRender(this.currentTime, false);
  }

  async seek(time: number): Promise<void> {
    if (!this.composition) return;
    this.currentTime = clamp(time, 0, this.composition.duration);
    this.callbacks.onTimeUpdate(this.currentTime);
    await this.audioTransport.seek(
      this.currentTime,
      audioClipsStartingFrom(this.composition, this.currentTime),
      this.composition.duration,
    );
    this.playing = this.audioTransport.isPlaying();
    this.callbacks.onPlayingChange(this.playing);
    if (this.playing) this.startLoop();
    await this.queueRender(this.currentTime, true);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.stopLoop();
    await this.audioTransport.destroy();
    for (const value of this.videoPlayers.values()) {
      if (!isPromiseLike(value) && value) {
        await value.destroy().catch(() => {});
      }
    }
    this.videoPlayers.clear();
    this.renderer.destroy();
  }
}
