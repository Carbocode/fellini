import {
  activeVideoLayersAtTime,
  audioClipsStartingFrom,
  clipLocalTime,
  type MonitorComposition,
  type MonitorVideoLayer,
} from "./composition";
import {
  decodeAudioTrackToAudioBuffer,
  MonitorAudioTransport,
  type MonitorAudioTransportDebugState,
} from "./audio";
import { demuxMp4Asset, type DemuxedMp4Asset } from "./mp4";
import { MonitorWebGpuRenderer, type RenderVideoLayer } from "./renderer";
import {
  VideoClipPlayer,
  type VideoClipPlayerDebugState,
  type VideoDecodeIntent,
} from "./video";

type MonitorStatus = "ready" | "unsupported";

export type MonitorRuntimeEvent = {
  atMs: number;
  scope: string;
  message: string;
};

export type MonitorLayerDiagnostics = {
  key: string;
  clipId: string;
  assetId: string;
  mediaPath: string;
  localTimeUs: number;
  frameTimestampUs: number | null;
  frameDurationUs: number | null;
  includedInRender: boolean;
  player: VideoClipPlayerDebugState | null;
};

export type MonitorRuntimeDebugState = {
  playing: boolean;
  initialized: boolean;
  renderQueued: boolean;
  rendering: boolean;
  rafActive: boolean;
  pendingRenderTime: number | null;
  pendingRenderBlocking: boolean | null;
  lastRenderRequestTime: number | null;
  lastRenderRequestBlocking: boolean | null;
  lastCompletedRenderTime: number | null;
  lastCompletedRenderBlocking: boolean | null;
  compositionRevisionKey: string | null;
  compositionDuration: number;
  demuxCacheEntries: number;
  audioBufferCacheEntries: number;
  videoPlayerEntries: number;
  readyVideoPlayers: number;
};

export type MonitorDiagnostics = {
  renderer: "webgpu";
  currentTime: number;
  activeLayers: number;
  renderedLayers: number;
  decodedFrames: number;
  bufferedFrames: number;
  runtime: MonitorRuntimeDebugState;
  audio: MonitorAudioTransportDebugState;
  layers: MonitorLayerDiagnostics[];
  events: MonitorRuntimeEvent[];
  lastError: string | null;
};

type MonitorDiagnosticsCore = Pick<
  MonitorDiagnostics,
  "currentTime" | "activeLayers" | "renderedLayers" | "decodedFrames" | "bufferedFrames"
>;

type RuntimeCallbacks = {
  onTimeUpdate: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onGpuStatus: (status: MonitorStatus) => void;
  onCodecStatus: (status: MonitorStatus) => void;
  onDiagnostics?: (diagnostics: MonitorDiagnostics) => void;
  onError?: (error: Error) => void;
};

type MediaUrlResolver = (mediaPath: string) => string | null;
type RenderRequest = {
  time: number;
  blocking: boolean;
  playing: boolean;
  intent: VideoDecodeIntent;
};

function isPromiseLike<T>(value: Promise<T> | T): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function secondsToMicroseconds(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cloneFrameForRender(frame: VideoFrame): VideoFrame | null {
  try {
    return frame.clone();
  } catch {
    return null;
  }
}

function playerKeyForMedia(clipId: string, mediaPath: string): string {
  return `${clipId}:${mediaPath}`;
}

function playerKeyForLayer(layer: MonitorVideoLayer): string {
  return playerKeyForMedia(layer.clipId, layer.mediaPath);
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
  private pendingRender: RenderRequest | null = null;
  private lastRenderRequest: RenderRequest | null = null;
  private lastCompletedRender: RenderRequest | null = null;
  private initialized = false;
  private destroyed = false;
  private lastErrorMessage: string | null = null;
  private debugEvents: MonitorRuntimeEvent[] = [];
  private lastDiagnosticsSnapshot: Omit<MonitorDiagnostics, "renderer" | "lastError"> = {
    currentTime: 0,
    activeLayers: 0,
    renderedLayers: 0,
    decodedFrames: 0,
    bufferedFrames: 0,
    runtime: {
      playing: false,
      initialized: false,
      renderQueued: false,
      rendering: false,
      rafActive: false,
      pendingRenderTime: null,
      pendingRenderBlocking: null,
      lastRenderRequestTime: null,
      lastRenderRequestBlocking: null,
      lastCompletedRenderTime: null,
      lastCompletedRenderBlocking: null,
      compositionRevisionKey: null,
      compositionDuration: 0,
      demuxCacheEntries: 0,
      audioBufferCacheEntries: 0,
      videoPlayerEntries: 0,
      readyVideoPlayers: 0,
    },
    audio: {
      playing: false,
      contextState: "uninitialized",
      contextCurrentTime: null,
      sampleRate: null,
      startContextTime: 0,
      startTimelineTime: 0,
      duration: 0,
      sessionToken: 0,
      scheduledNodeCount: 0,
    },
    layers: [],
    events: [],
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

  private pushDebugEvent(scope: string, message: string): void {
    const event: MonitorRuntimeEvent = {
      atMs: Math.round(performance.now()),
      scope,
      message,
    };
    this.debugEvents = [...this.debugEvents.slice(-39), event];
  }

  private readyVideoPlayersCount(): number {
    return [...this.videoPlayers.values()].filter((value) => !isPromiseLike(value) && !!value).length;
  }

  private collectRuntimeDebugState(): MonitorRuntimeDebugState {
    return {
      playing: this.playing,
      initialized: this.initialized,
      renderQueued: this.renderQueued,
      rendering: this.rendering,
      rafActive: this.raf !== 0,
      pendingRenderTime: this.pendingRender?.time ?? null,
      pendingRenderBlocking: this.pendingRender?.blocking ?? null,
      lastRenderRequestTime: this.lastRenderRequest?.time ?? null,
      lastRenderRequestBlocking: this.lastRenderRequest?.blocking ?? null,
      lastCompletedRenderTime: this.lastCompletedRender?.time ?? null,
      lastCompletedRenderBlocking: this.lastCompletedRender?.blocking ?? null,
      compositionRevisionKey: this.composition?.revisionKey ?? null,
      compositionDuration: this.composition?.duration ?? 0,
      demuxCacheEntries: this.demuxCache.size,
      audioBufferCacheEntries: this.audioBufferCache.size,
      videoPlayerEntries: this.videoPlayers.size,
      readyVideoPlayers: this.readyVideoPlayersCount(),
    };
  }

  private publishCapabilityStatus(): void {
    const gpuReady = !!((navigator as Navigator & { gpu?: unknown }).gpu);
    const codecsReady = ("VideoDecoder" in window) && ("AudioDecoder" in window);
    this.callbacks.onGpuStatus(gpuReady ? "ready" : "unsupported");
    this.callbacks.onCodecStatus(codecsReady ? "ready" : "unsupported");
  }

  private publishDiagnostics(
    core: MonitorDiagnosticsCore,
    layers: MonitorLayerDiagnostics[] = this.lastDiagnosticsSnapshot.layers,
  ): void {
    this.lastDiagnosticsSnapshot = {
      ...core,
      runtime: this.collectRuntimeDebugState(),
      audio: this.audioTransport.getDebugState(),
      layers,
      events: [...this.debugEvents],
    };
    this.callbacks.onDiagnostics?.({
      renderer: "webgpu",
      lastError: this.lastErrorMessage,
      ...this.lastDiagnosticsSnapshot,
    });
  }

  private reportError(error: Error): void {
    this.lastErrorMessage = error.message;
    this.pushDebugEvent("error", error.message);
    this.callbacks.onError?.(error);
    this.publishDiagnostics({
      currentTime: this.lastDiagnosticsSnapshot.currentTime,
      activeLayers: this.lastDiagnosticsSnapshot.activeLayers,
      renderedLayers: this.lastDiagnosticsSnapshot.renderedLayers,
      decodedFrames: this.lastDiagnosticsSnapshot.decodedFrames,
      bufferedFrames: this.lastDiagnosticsSnapshot.bufferedFrames,
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
        this.pushDebugEvent("renderer", "initialized");
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

  private getVideoPlayerForMedia(clipId: string, mediaPath: string): Promise<VideoClipPlayer | null> {
    const key = playerKeyForMedia(clipId, mediaPath);
    const cached = this.videoPlayers.get(key);
    if (cached !== undefined) {
      return isPromiseLike(cached) ? cached : Promise.resolve(cached);
    }
    const pending = this.ensureDemuxed(mediaPath)
      .then((asset) => {
        if (!asset.video) return null;
        const player = new VideoClipPlayer(
          asset.video,
          () => this.requestRender(),
          (error) => this.reportError(error),
        );
        this.videoPlayers.set(key, player);
        this.pushDebugEvent("player", `created ${key}`);
        return player;
      })
      .catch((error) => {
        this.videoPlayers.delete(key);
        this.pushDebugEvent("player", `failed ${key}`);
        this.reportError(error instanceof Error ? error : new Error("Init player video fallita"));
        return null;
      });
    this.videoPlayers.set(key, pending);
    return pending;
  }

  private getVideoPlayer(layer: MonitorVideoLayer): Promise<VideoClipPlayer | null> {
    return this.getVideoPlayerForMedia(layer.clipId, layer.mediaPath);
  }

  private async reconcileVideoPlayers(): Promise<void> {
    if (!this.composition) return;
    const wantedKeys = new Set<string>();
    for (const layer of this.composition.videoLayers) {
      wantedKeys.add(playerKeyForLayer(layer));
      if (layer.maskMediaPath) wantedKeys.add(playerKeyForMedia(layer.clipId, layer.maskMediaPath));
    }
    let removed = 0;
    for (const [key, value] of this.videoPlayers.entries()) {
      if (wantedKeys.has(key)) continue;
      this.videoPlayers.delete(key);
       removed += 1;
      if (!isPromiseLike(value) && value) {
        await value.destroy().catch(() => {});
      }
    }
    if (removed > 0) this.pushDebugEvent("player", `reconciled removed=${removed}`);
  }

  private async preloadAssets(): Promise<void> {
    if (!this.composition) return;
    const uniqueMediaPaths = new Set([
      ...this.composition.videoLayers.map((layer) => layer.mediaPath),
      ...this.composition.videoLayers.map((layer) => layer.maskMediaPath).filter((path): path is string => !!path),
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
    this.pushDebugEvent("loop", "stopped");
  }

  private startLoop(): void {
    if (this.raf || !this.playing) return;
    this.pushDebugEvent("loop", "started");
    const step = () => {
      this.raf = 0;
      if (!this.playing || !this.composition) return;
      this.currentTime = clamp(this.audioTransport.getCurrentTime(), 0, this.composition.duration);
      this.callbacks.onTimeUpdate(this.currentTime);
      if (this.currentTime >= this.composition.duration) {
        void this.pause();
        return;
      }
      void this.queueRender(this.currentTime, false, true, "play-tick");
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private requestRender(): void {
    if (this.renderQueued || this.destroyed || !this.playing) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      void this.queueRender(
        this.currentTime,
        false,
        this.playing,
        this.playing ? "play-tick" : "snapshot",
      );
    });
  }

  private async buildRenderLayers(
    composition: MonitorComposition,
    time: number,
    blocking: boolean,
    playing: boolean,
    intent: VideoDecodeIntent,
  ): Promise<{
    activeLayerCount: number;
    decodedFrameCount: number;
    bufferedFrameCount: number;
    renderLayers: RenderVideoLayer[];
    layerDiagnostics: MonitorLayerDiagnostics[];
  }> {
    const activeLayers = activeVideoLayersAtTime(composition, time);
    const renderLayers: RenderVideoLayer[] = [];
    const layerDiagnostics: MonitorLayerDiagnostics[] = [];
    let decodedFrameCount = 0;
    let bufferedFrameCount = 0;
    for (const layer of activeLayers) {
      const layerKey = playerKeyForLayer(layer);
      const player = await this.getVideoPlayer(layer);
      const localTimeUs = secondsToMicroseconds(clipLocalTime(layer, time));
      if (!player) {
        layerDiagnostics.push({
          key: layerKey,
          clipId: layer.clipId,
          assetId: layer.assetId,
          mediaPath: layer.mediaPath,
          localTimeUs,
          frameTimestampUs: null,
          frameDurationUs: null,
          includedInRender: false,
          player: null,
        });
        continue;
      }
      if (blocking) {
        await player.requestFrame(localTimeUs, { playing, intent, blocking: true }).catch((error) => {
          this.reportError(error instanceof Error ? error : new Error("Decode video fallita"));
        });
      } else {
        void player.requestFrame(localTimeUs, { playing, intent, blocking: false }).catch((error) => {
          this.reportError(error instanceof Error ? error : new Error("Decode video fallita"));
        });
      }
      const stats = player.getStats();
      decodedFrameCount += stats.decodedFrames;
      bufferedFrameCount += stats.bufferedFrames;
      const playerState = player.getDebugState();
      const frame = player.getFrameAtTime(localTimeUs);
      const renderFrame = frame ? cloneFrameForRender(frame) : null;
      let renderMaskFrame: VideoFrame | null = null;
      if (layer.maskMediaPath) {
        const maskPlayer = await this.getVideoPlayerForMedia(layer.clipId, layer.maskMediaPath);
        if (maskPlayer) {
          if (blocking) {
            await maskPlayer.requestFrame(localTimeUs, { playing, intent, blocking: true }).catch((error) => {
              this.reportError(error instanceof Error ? error : new Error("Decode mask video fallita"));
            });
          } else {
            void maskPlayer.requestFrame(localTimeUs, { playing, intent, blocking: false }).catch((error) => {
              this.reportError(error instanceof Error ? error : new Error("Decode mask video fallita"));
            });
          }
          const maskStats = maskPlayer.getStats();
          decodedFrameCount += maskStats.decodedFrames;
          bufferedFrameCount += maskStats.bufferedFrames;
          const maskFrame = maskPlayer.getFrameAtTime(localTimeUs);
          renderMaskFrame = maskFrame ? cloneFrameForRender(maskFrame) : null;
        }
      }
      const includedInRender = !!renderFrame;
      layerDiagnostics.push({
        key: layerKey,
        clipId: layer.clipId,
        assetId: layer.assetId,
        mediaPath: layer.mediaPath,
        localTimeUs,
        frameTimestampUs: frame?.timestamp ?? null,
        frameDurationUs: frame?.duration ?? null,
        includedInRender,
        player: playerState,
      });
      if (!renderFrame) continue;
      renderLayers.push({ spec: layer, frame: renderFrame, maskFrame: renderMaskFrame });
    }
    return {
      activeLayerCount: activeLayers.length,
      decodedFrameCount,
      bufferedFrameCount,
      renderLayers,
      layerDiagnostics,
    };
  }

  private async renderAtTime(
    time: number,
    blocking: boolean,
    playing: boolean,
    intent: VideoDecodeIntent,
  ): Promise<void> {
    const composition = this.composition;
    if (!composition) return;
    this.lastRenderRequest = { time, blocking, playing, intent };
    const ready = await this.ensureRenderer();
    if (!ready) {
      this.publishDiagnostics({
        currentTime: time,
        activeLayers: 0,
        renderedLayers: 0,
        decodedFrames: 0,
        bufferedFrames: 0,
      }, []);
      return;
    }
    const result = await this.buildRenderLayers(composition, time, blocking, playing, intent);
    this.renderer.render(composition.sequence, result.renderLayers);
    this.lastCompletedRender = { time, blocking, playing, intent };
    if (result.activeLayerCount > 0 && result.renderLayers.length === 0) {
      this.pushDebugEvent("render", `no-renderable-layers t=${time.toFixed(3)} active=${result.activeLayerCount}`);
    }
    this.publishDiagnostics({
      currentTime: time,
      activeLayers: result.activeLayerCount,
      renderedLayers: result.renderLayers.length,
      decodedFrames: result.decodedFrameCount,
      bufferedFrames: result.bufferedFrameCount,
    }, result.layerDiagnostics);
  }

  private queueRender(
    time: number,
    blocking: boolean,
    playing = this.playing,
    intent: VideoDecodeIntent = playing ? "play-tick" : "snapshot",
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    const request: RenderRequest = { time, blocking, playing, intent };
    if (this.rendering) {
      this.pendingRender = this.pendingRender
        ? {
          time,
          blocking: this.pendingRender.blocking || blocking,
          playing,
          intent,
        }
        : request;
      this.lastRenderRequest = request;
      return this.renderDrainPromise ?? Promise.resolve();
    }

    this.lastRenderRequest = request;
    this.rendering = true;
    this.renderDrainPromise = (async () => {
      let nextRequest: RenderRequest | null = request;
      while (nextRequest && !this.destroyed) {
        const currentRequest = nextRequest;
        nextRequest = null;
        await this.renderAtTime(
          currentRequest.time,
          currentRequest.blocking,
          currentRequest.playing,
          currentRequest.intent,
        );
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
      this.pushDebugEvent("composition", "cleared");
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
      }, []);
      return;
    }
    this.pushDebugEvent(
      "composition",
      `set revision=${composition.revisionKey} duration=${composition.duration.toFixed(3)}`,
    );
    this.currentTime = clamp(this.currentTime, 0, composition.duration);
    await this.reconcileVideoPlayers();
    void this.preloadAssets();
    if (this.playing) {
      await this.audioTransport.seek(this.currentTime, audioClipsStartingFrom(composition, this.currentTime), composition.duration);
    }
    await this.queueRender(
      this.currentTime,
      true,
      this.playing,
      this.playing ? "play-start" : "snapshot",
    );
  }

  async play(): Promise<void> {
    if (!this.composition || this.playing) return;
    this.pushDebugEvent("transport", `play t=${this.currentTime.toFixed(3)}`);
    const ready = await this.ensureRenderer();
    if (!ready) return;
    this.currentTime = clamp(this.currentTime, 0, this.composition.duration);
    await this.audioTransport.play(
      audioClipsStartingFrom(this.composition, this.currentTime),
      this.currentTime,
      this.composition.duration,
    );
    this.playing = this.audioTransport.isPlaying();
    this.callbacks.onPlayingChange(this.playing);
    this.callbacks.onTimeUpdate(this.currentTime);
    await this.queueRender(this.currentTime, true, this.playing, "play-start");
    if (this.playing) this.startLoop();
  }

  async pause(): Promise<void> {
    if (!this.playing) return;
    this.currentTime = this.composition
      ? clamp(await this.audioTransport.pause(), 0, this.composition.duration)
      : await this.audioTransport.pause();
    this.pushDebugEvent("transport", `pause t=${this.currentTime.toFixed(3)}`);
    this.playing = false;
    this.stopLoop();
    this.callbacks.onPlayingChange(false);
    this.callbacks.onTimeUpdate(this.currentTime);
    await this.queueRender(this.currentTime, true, false, "snapshot");
  }

  async seek(time: number): Promise<void> {
    if (!this.composition) return;
    this.pushDebugEvent("transport", `seek ${this.currentTime.toFixed(3)} -> ${time.toFixed(3)}`);
    this.currentTime = clamp(time, 0, this.composition.duration);
    this.callbacks.onTimeUpdate(this.currentTime);
    await this.audioTransport.seek(
      this.currentTime,
      audioClipsStartingFrom(this.composition, this.currentTime),
      this.composition.duration,
    );
    this.playing = this.audioTransport.isPlaying();
    this.callbacks.onPlayingChange(this.playing);
    await this.queueRender(
      this.currentTime,
      true,
      this.playing,
      this.playing ? "play-start" : "snapshot",
    );
    if (this.playing) this.startLoop();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.pushDebugEvent("runtime", "destroy");
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
