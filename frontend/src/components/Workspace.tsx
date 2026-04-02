import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import {
  useEditorialProjectQuery,
  useJobPolling,
  useJobQuery,
  useRequestAssetPreviewsMutation,
  useTranscribeLaneMutation,
  useUpdateEditorialProjectMutation,
  useUploadEditorialAssetMutation,
} from "../api/queries";
import { fileUrl } from "../api/client";
import {
  autoFollow,
  frameStepRequest,
  playPauseRequest,
  playheadTime,
  seekRequest,
  selectedClipId,
  selectedJobId,
  selectedSubtitleId,
  selectedTrackId,
  setAutoFollow,
  setFrameStepRequest,
  setPlayheadTime,
  setPlayPauseRequest,
  setPreviewForJob,
  setSeekRequest,
  setSelectedClipId,
  setSelectedSubtitleId,
  setSelectedTrackId,
  updateTabLabel,
} from "../store";
import type {
  AssetPreviewEntry,
  EditorialProject,
  JobSnapshot,
  ProjectAsset,
  TimelineClip,
  TimelineTrack,
} from "../types";
import {
  assetById,
  compatibleTrack,
  createClipsForAssetDrop,
  getClip,
  getSubtitleBlock,
  getTrack,
  laneContentRange,
  linkedClips,
  normalizeEditorialProject,
  projectDuration,
  retargetClipGroup,
  resolveClipGroupStart,
  resolveClipGroupTrimEndDelta,
  resolveClipGroupTrimStartDelta,
  sortedTracks,
  splitClip,
  subtitleTrack,
  trackClips,
  trackHeight,
  trackSubtitles,
  upsertClips,
} from "../lib/editorial";
import {
  baseName,
  fmtTime,
  fmtTimePrecise,
  humanizeMediaName,
} from "../lib/utils";
import PipelineBar from "./PipelineBar";
import ParamsInspector from "./ParamsInspector";

const TIMELINE_SPLITTER_HEIGHT = 4;
const PANEL_SPLITTER_WIDTH = 4;
const MIN_TIMELINE_HEIGHT = 180;
const MIN_TOP_WORKSPACE_HEIGHT = 220;
const MIN_BROWSER_WIDTH = 220;
const MAX_BROWSER_WIDTH = 440;
const MIN_PX_PER_SEC = 60;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
const ZOOM_WHEEL_THRESHOLD = 18;
const TIMELINE_TAIL_RATIO = 0.5;
const TIMELINE_TAIL_MIN_SECONDS = 60;
const TIMELINE_TAIL_MAX_SECONDS = 600;
const RULER_MINOR_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const RULER_MINOR_TARGET_PX = 18;
const RULER_LABEL_EVERY_N_TICKS = 4;
const TIMELINE_RULER_HEIGHT = 20;
const AUDIO_PREWARM_LEAD_SECONDS = 0.8;
const AUDIO_PREWARM_TRAIL_SECONDS = 0.2;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "fellini:workspace-sidebar-collapsed";
const CLIP_PREVIEW_MIN_WIDTH_PX = 32;

type ProjectUpdater = EditorialProject | ((current: EditorialProject) => EditorialProject);
type WaveformData = {
  version: number;
  metric: string;
  channels: number;
  duration: number;
  bucket_count: number;
  values: number[];
};

const waveformDataCache = new Map<string, Promise<WaveformData> | WaveformData>();

function clipPreviewEntry(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
): AssetPreviewEntry | null {
  if (!asset) return null;
  if (trackKind === "video") {
    if (asset.kind !== "video") return null;
    return asset.preview?.filmstrip ?? null;
  }
  if (asset.kind !== "audio" && !asset.has_audio) return null;
  return asset.preview?.waveform ?? null;
}

function clipPreviewStatus(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
): "missing" | "generating" | "ready" | "failed" {
  return clipPreviewEntry(asset, trackKind)?.status ?? "missing";
}

function assetSupportsClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
): boolean {
  if (!asset) return false;
  if (trackKind === "video") return asset.kind === "video";
  return asset.kind === "audio" || asset.has_audio;
}

function shouldRequestClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
): boolean {
  return assetSupportsClipPreview(asset, trackKind) && clipPreviewStatus(asset, trackKind) === "missing";
}

function hasGeneratingClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
): boolean {
  return assetSupportsClipPreview(asset, trackKind) && clipPreviewStatus(asset, trackKind) === "generating";
}

function shouldRequestAnyAssetPreview(asset: ProjectAsset | null | undefined): boolean {
  if (!asset) return false;
  return shouldRequestClipPreview(asset, "video") || shouldRequestClipPreview(asset, "audio");
}

function readPersistedSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT");
}

function containScale(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): [number, number] {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return [1, 1];
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  if (sourceAspect > targetAspect) {
    return [1, targetAspect / sourceAspect];
  }
  return [sourceAspect / targetAspect, 1];
}

async function loadWaveformData(src: string): Promise<WaveformData> {
  const cached = waveformDataCache.get(src);
  if (cached instanceof Promise) return cached;
  if (cached) return cached;
  const pending = fetch(src, { cache: "force-cache" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Waveform non disponibile");
      const payload = await response.json() as WaveformData;
      waveformDataCache.set(src, payload);
      return payload;
    })
    .catch((error) => {
      waveformDataCache.delete(src);
      throw error;
    });
  waveformDataCache.set(src, pending);
  return pending;
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const WaveformClipPreview: Component<{
  src: string;
  clip: TimelineClip;
  assetDuration: number;
}> = (props) => {
  const [data, setData] = createSignal<WaveformData | null>(null);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(
    on(
      () => props.src,
      (src) => {
        let cancelled = false;
        if (!src) {
          setData(null);
          return;
        }
        void loadWaveformData(src)
          .then((payload) => {
            if (!cancelled) setData(payload);
          })
          .catch(() => {
            if (!cancelled) setData(null);
          });
        onCleanup(() => {
          cancelled = true;
        });
      },
    ),
  );

  createEffect(() => {
    if (!canvasRef) return;
    const updateSize = () => setSize({
      width: Math.round(canvasRef!.clientWidth),
      height: Math.round(canvasRef!.clientHeight),
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvasRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const payload = data();
    const width = size().width;
    const height = size().height;
    if (!canvasRef || !payload || width <= 0 || height <= 0) return;
    const context = canvasRef.getContext("2d");
    if (!context) return;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    canvasRef.width = Math.max(1, Math.round(width * dpr));
    canvasRef.height = Math.max(1, Math.round(height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(139, 231, 164, 0.88)";
    const values = payload.values;
    const totalDuration = Math.max(props.assetDuration, payload.duration, 0.01);
    const start = Math.max(0, Math.min(props.clip.source_in, totalDuration));
    const end = Math.max(start + 0.001, Math.min(props.clip.source_out, totalDuration));
    const startIndex = Math.floor((start / totalDuration) * values.length);
    const endIndex = Math.max(startIndex + 1, Math.ceil((end / totalDuration) * values.length));
    const midY = height / 2;
    for (let x = 0; x < width; x += 1) {
      const from = startIndex + Math.floor((x / width) * (endIndex - startIndex));
      const to = Math.min(
        values.length,
        startIndex + Math.max(
          Math.ceil(((x + 1) / width) * (endIndex - startIndex)),
          Math.floor((x / width) * (endIndex - startIndex)) + 1,
        ),
      );
      let peak = 0;
      for (let index = from; index < to; index += 1) {
        peak = Math.max(peak, values[index] ?? 0);
      }
      if (peak <= 0) continue;
      const amplitude = peak / 255;
      const barHeight = Math.max(1, amplitude * (height * 0.5));
      context.fillRect(x, midY - barHeight, 1, barHeight * 2);
    }
  });

  return <canvas ref={canvasRef} class="tl-waveform-canvas" aria-hidden="true" />;
};

const FilmstripClipPreview: Component<{
  src: string;
  clip: TimelineClip;
  assetDuration: number;
  entry: AssetPreviewEntry;
}> = (props) => {
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let containerRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!containerRef) return;
    const updateSize = () => setSize({
      width: Math.round(containerRef!.clientWidth),
      height: Math.round(containerRef!.clientHeight),
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
  });

  const frameCount = createMemo(() => Math.max(1, Math.round(metaNumber(props.entry.meta, "frame_count", 1))));
  const cellWidth = createMemo(() => Math.max(1, metaNumber(props.entry.meta, "cell_width", 96)));
  const cellHeight = createMemo(() => Math.max(1, metaNumber(props.entry.meta, "cell_height", 72)));
  const tileCount = createMemo(() => {
    const width = size().width;
    const height = size().height;
    if (width <= 0 || height <= 0) return 1;
    const desiredTileWidth = Math.max(18, height * (cellWidth() / cellHeight()));
    return Math.max(1, Math.round(width / desiredTileWidth));
  });
  const tiles = createMemo(() => {
    const count = tileCount();
    const start = Math.max(0, Math.min(props.clip.source_in, props.assetDuration));
    const end = Math.max(start + 0.001, Math.min(props.clip.source_out, props.assetDuration));
    return Array.from({ length: count }, (_, index) => {
      const time = start + (((index + 0.5) / count) * (end - start));
      const frameIndex = frameCount() <= 1
        ? 0
        : Math.max(
            0,
            Math.min(
              frameCount() - 1,
              Math.round((time / Math.max(props.assetDuration, 0.001)) * (frameCount() - 1)),
            ),
          );
      return {
        id: `${index}:${frameIndex}`,
        backgroundPosition: frameCount() <= 1
          ? "0% 50%"
          : `${(frameIndex / (frameCount() - 1)) * 100}% 50%`,
      };
    });
  });

  return (
    <div
      ref={containerRef}
      class="tl-filmstrip-grid"
      style={{ "grid-template-columns": `repeat(${tileCount()}, minmax(0, 1fr))` }}
    >
      <For each={tiles()}>
        {(tile) => (
          <div
            class="tl-filmstrip-tile"
            style={{
              "background-image": `url("${props.src}")`,
              "background-size": `${frameCount() * 100}% 100%`,
              "background-position": tile.backgroundPosition,
            }}
          />
        )}
      </For>
    </div>
  );
};

const TimelineClipPreview: Component<{
  jobId: string;
  clip: TimelineClip;
  asset: ProjectAsset;
  trackKind: "video" | "audio";
}> = (props) => {
  const entry = () => clipPreviewEntry(props.asset, props.trackKind);
  const status = () => entry()?.status ?? "missing";
  const src = () => {
    const path = entry()?.status === "ready" ? entry()?.resource_path : null;
    return path ? fileUrl(props.jobId, path) : null;
  };
  const clipDuration = () => Math.max(0.001, props.clip.source_out - props.clip.source_in);
  const assetDuration = () => Math.max(props.asset.duration, props.clip.source_out, clipDuration());

  return (
    <div
      class="tl-clip-preview-body"
      classList={{
        "has-media": !!src(),
        "is-loading": status() === "generating",
      }}
      data-status={status()}
      aria-hidden="true"
    >
      <Show when={props.trackKind === "video" && src() && entry()}>
        <FilmstripClipPreview
          src={src()!}
          clip={props.clip}
          assetDuration={assetDuration()}
          entry={entry()!}
        />
      </Show>
      <Show when={props.trackKind === "audio" && src()}>
        {(resolvedSrc) => (
          <WaveformClipPreview
            src={resolvedSrc()}
            clip={props.clip}
            assetDuration={assetDuration()}
          />
        )}
      </Show>
      <Show when={!src()}>
        <div
          class={`tl-clip-preview-placeholder tl-clip-preview-placeholder--${props.trackKind}${status() === "generating" ? " is-loading" : ""}`}
        />
      </Show>
    </div>
  );
};

function formatRulerLabel(seconds: number, labelStep: number): string {
  if (labelStep < 1) return fmtTimePrecise(seconds);
  return fmtTime(seconds);
}

const Workspace: Component = () => {
  const job = useJobQuery(selectedJobId);
  const projectQuery = useEditorialProjectQuery(selectedJobId);
  const saveProject = useUpdateEditorialProjectMutation();
  const data = () => job.data as JobSnapshot | undefined;
  const [draftProject, setDraftProject] = createSignal<EditorialProject | null>(null);
  const [timelineHeight, setTimelineHeight] = createSignal<number | null>(null);
  const [browserWidth, setBrowserWidth] = createSignal(280);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(readPersistedSidebarCollapsed());
  let editorMainRef: HTMLDivElement | undefined;
  let saveHandle: ReturnType<typeof setTimeout> | undefined;

  const polling = useJobPolling(selectedJobId);
  createEffect(
    on(
      () => data()?.title,
      (title) => {
        const id = selectedJobId();
        if (id && title) updateTabLabel(id, title);
      },
    ),
  );
  createEffect(
    on(
      () => data()?.status,
      (status) => {
        if (status === "running") polling.start();
        else polling.stop();
      },
    ),
  );
  onCleanup(() => polling.stop());

  createEffect(
    on(
      () => projectQuery.data,
      (incoming) => {
        if (!incoming) {
          setDraftProject(null);
          return;
        }
        const normalized = normalizeEditorialProject(
          JSON.parse(JSON.stringify(incoming)) as EditorialProject,
        );
        setDraftProject((current) => {
          if (!current || current.revision !== normalized.revision) return normalized;
          const previewByAssetId = new Map(
            normalized.assets.map((asset) => [asset.id, asset.preview ?? null]),
          );
          let changed = false;
          const mergedAssets = current.assets.map((asset) => {
            if (!previewByAssetId.has(asset.id)) return asset;
            const nextPreview = previewByAssetId.get(asset.id) ?? null;
            if (JSON.stringify(asset.preview ?? null) === JSON.stringify(nextPreview)) {
              return asset;
            }
            changed = true;
            return { ...asset, preview: nextPreview };
          });
          return changed ? normalizeEditorialProject({ ...current, assets: mergedAssets }) : current;
        });
      },
    ),
  );

  createEffect(
    on(
      () => data()?.id,
      () => {
        setSelectedTrackId(null);
        setSelectedClipId(null);
        setSelectedSubtitleId(null);
      },
    ),
  );

  createEffect(
    on(sidebarCollapsed, (collapsed) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
      } catch {
        // Ignore storage failures and keep the in-memory state.
      }
    }),
  );

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!draftProject() || isTypingTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlayPauseRequest((value) => value + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFrameStepRequest(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFrameStepRequest(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const persistProject = (project: EditorialProject) => {
    const jobId = selectedJobId();
    if (!jobId) return;
    clearTimeout(saveHandle);
    saveHandle = setTimeout(() => {
      saveProject.mutate({ jobId, project });
    }, 220);
  };
  onCleanup(() => clearTimeout(saveHandle));

  const updateProject = (next: ProjectUpdater) => {
    const current = draftProject();
    if (!current) return;
    const updated =
      typeof next === "function"
        ? (next as (project: EditorialProject) => EditorialProject)(current)
        : next;
    const normalized = normalizeEditorialProject(updated);
    setDraftProject(normalized);
    persistProject(normalized);
  };

  const clampBrowserWidth = (width: number) =>
    Math.max(MIN_BROWSER_WIDTH, Math.min(MAX_BROWSER_WIDTH, Math.round(width)));
  const clampTimelineHeight = (height: number) => {
    if (!editorMainRef) return Math.max(MIN_TIMELINE_HEIGHT, Math.round(height));
    const totalHeight = editorMainRef.getBoundingClientRect().height - TIMELINE_SPLITTER_HEIGHT;
    const maxHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight - MIN_TOP_WORKSPACE_HEIGHT);
    return Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxHeight, Math.round(height)));
  };
  const editorShellColumns = () =>
    sidebarCollapsed()
      ? `0px 0px minmax(0, 1fr)`
      : `${browserWidth()}px ${PANEL_SPLITTER_WIDTH}px minmax(0, 1fr)`;
  const editorMainRows = () =>
    timelineHeight() === null
      ? `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px minmax(0, 1fr)`
      : `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px ${timelineHeight()}px`;

  const onBrowserResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = browserWidth();
    const onMove = (ev: PointerEvent) => setBrowserWidth(clampBrowserWidth(startWidth + ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const onTimelineResizeStart = (e: PointerEvent) => {
    if (!editorMainRef) return;
    e.preventDefault();
    const totalHeight = editorMainRef.getBoundingClientRect().height - TIMELINE_SPLITTER_HEIGHT;
    const startY = e.clientY;
    const startHeight = timelineHeight() ?? Math.max(MIN_TIMELINE_HEIGHT, Math.round(totalHeight * 0.5));
    const onMove = (ev: PointerEvent) => setTimelineHeight(clampTimelineHeight(startHeight + (startY - ev.clientY)));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  createEffect(() => {
    if (!editorMainRef) return;
    const syncTimelineHeight = () => {
      const totalHeight = editorMainRef!.getBoundingClientRect().height - TIMELINE_SPLITTER_HEIGHT;
      const fallback = Math.max(MIN_TIMELINE_HEIGHT, Math.round(totalHeight * 0.5));
      setTimelineHeight((current) => clampTimelineHeight(current ?? fallback));
    };
    syncTimelineHeight();
    const observer = new ResizeObserver(syncTimelineHeight);
    observer.observe(editorMainRef);
    onCleanup(() => observer.disconnect());
  });

  return (
    <main class="workspace">
      <Show when={data()} fallback={<div class="empty-state"><div class="empty-content"><p>Caricamento progetto...</p></div></div>}>
        <div class="project-workspace">
          <div class="editor-shell" style={{ "grid-template-columns": editorShellColumns() }}>
            <div class="browser-col" style={{ overflow: "hidden" }}>
              <AssetBrowserPanel project={draftProject} />
            </div>
            <div
              class="browser-resize-handle"
              style={{ visibility: sidebarCollapsed() ? "hidden" : "visible" }}
              onPointerDown={onBrowserResizeStart}
            />
            <div class="editor-main-wrap">
              <div class="pipeline-bar-row">
                <button
                  type="button"
                  class="sidebar-toggle-btn"
                  title={sidebarCollapsed() ? "Mostra sidebar" : "Nascondi sidebar"}
                  onClick={() => setSidebarCollapsed((value) => !value)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
                <PipelineBar />
              </div>
              <div ref={editorMainRef} class="editor-main" style={{ "grid-template-rows": editorMainRows() }}>
                <WorkspaceGrid project={draftProject} updateProject={updateProject} />
                <div class="workspace-vsplit" onPointerDown={onTimelineResizeStart} />
                <TimelinePanel project={draftProject} updateProject={updateProject} />
              </div>
            </div>
          </div>
        </div>
      </Show>
    </main>
  );
};

const WorkspaceGrid: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: ProjectUpdater) => void;
}> = (props) => {
  const [inspectorWidth, setInspectorWidth] = createSignal(340);
  const onResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorWidth();
    const onMove = (ev: PointerEvent) => setInspectorWidth(Math.max(240, Math.min(600, startW + (startX - ev.clientX))));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div class="workspace-grid" style={{ "grid-template-columns": `1fr 4px ${inspectorWidth()}px` }}>
      <div class="monitor-col">
        <MonitorPanel project={props.project} />
      </div>
      <div class="resize-handle" onPointerDown={onResizeStart} />
      <div class="inspector-col">
        <ParamsInspector project={props.project} updateProject={props.updateProject} />
      </div>
    </div>
  );
};

const AssetBrowserPanel: Component<{ project: Accessor<EditorialProject | null> }> = (props) => {
  const job = useJobQuery(selectedJobId);
  const requestAssetPreviews = useRequestAssetPreviewsMutation();
  const uploadAsset = useUploadEditorialAssetMutation();
  const [filter, setFilter] = createSignal("");
  const [selectedAssetId, setSelectedAssetId] = createSignal<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = createSignal<string | null>(null);
  const [draggingAssetId, setDraggingAssetId] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<"assets" | "logs">("assets");
  let inputRef: HTMLInputElement | undefined;

  const project = () => props.project();
  const assets = createMemo(() => {
    const items = project()?.assets ?? [];
    const f = filter().trim().toLowerCase();
    return items.filter((item) => !f || item.label.toLowerCase().includes(f) || baseName(item.path).toLowerCase().includes(f));
  });
  const previewAsset = createMemo(() => {
    const current = project();
    if (!current) return null;
    return assetById(current, previewAssetId() ?? "") ?? null;
  });
  const previewSrc = createMemo(() => {
    const current = previewAsset();
    const jobId = selectedJobId();
    return current && jobId ? fileUrl(jobId, current.path) : null;
  });
  const logs = createMemo(() => (job.data as JobSnapshot | undefined)?.logs ?? []);

  const openAssetPreview = (asset: ProjectAsset) => {
    setSelectedAssetId(asset.id);
    setPreviewAssetId(asset.id);
    const jobId = selectedJobId();
    if (jobId) setPreviewForJob(jobId, asset.path);
    if (jobId && job.data?.status !== "running" && shouldRequestAnyAssetPreview(asset)) {
      requestAssetPreviews.mutate({ jobId, assetIds: [asset.id] });
    }
  };
  const closeAssetPreview = () => setPreviewAssetId(null);

  const onFiles = (files: FileList | null) => {
    const jobId = selectedJobId();
    if (!jobId || !files?.length) return;
    Array.from(files).forEach((file) => uploadAsset.mutate({ jobId, file }));
    if (inputRef) inputRef.value = "";
  };

  return (
    <div class="panel asset-explorer">
      <div class="sidebar-tabs">
        <button type="button" class={`sidebar-tab${activeTab() === "assets" ? " active" : ""}`} onClick={() => setActiveTab("assets")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
          </svg>
          Assets
          <span class="sidebar-tab-badge">{assets().length}</span>
        </button>
        <button type="button" class={`sidebar-tab${activeTab() === "logs" ? " active" : ""}`} onClick={() => setActiveTab("logs")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16M4 10h16M4 14h10M4 18h12" />
          </svg>
          Log
        </button>
      </div>

      <div class="sidebar-tab-body" style={{ display: activeTab() === "assets" ? "flex" : "none" }}>
        <div class="asset-browser-actions">
          <button type="button" class="btn btn-primary btn-xs" onClick={() => inputRef?.click()}>
            Aggiungi asset
          </button>
          <input
            ref={inputRef}
            type="file"
            class="asset-upload-input"
            accept="video/*,audio/*"
            multiple
            onChange={(e) => onFiles(e.currentTarget.files)}
          />
        </div>
        <div class="asset-explorer-search">
          <svg class="asset-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            class="asset-search-input"
            placeholder="Filtra asset..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <div class="asset-explorer-content">
          <Show when={assets().length > 0} fallback={<div class="asset-explorer-empty"><span>Nessun asset disponibile</span></div>}>
            <For each={assets()}>
              {(asset) => (
                <div
                  role="button"
                  tabIndex={0}
                  class={`asset-item${selectedAssetId() === asset.id || previewAsset()?.id === asset.id ? " active" : ""}${draggingAssetId() === asset.id ? " is-dragging" : ""}`}
                  draggable={true}
                  onDragStart={(e) => {
                    setSelectedAssetId(asset.id);
                    setDraggingAssetId(asset.id);
                    if (!e.dataTransfer) return;
                    e.dataTransfer.setData("application/x-fellini-asset", asset.id);
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setDragImage(e.currentTarget, 18, 12);
                  }}
                  onDragEnd={() => {
                    setDraggingAssetId(null);
                    window.dispatchEvent(new CustomEvent("fellini:asset-drag-end"));
                  }}
                  onClick={() => setSelectedAssetId(asset.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedAssetId(asset.id);
                    }
                  }}
                >
                  <FileTypeIcon type={asset.kind} />
                  <span class="asset-item-name">{asset.label || humanizeMediaName(asset.path)}</span>
                  <button
                    type="button"
                    class={`asset-item-action${previewAssetId() === asset.id ? " active" : ""}`}
                    title={previewAssetId() === asset.id ? "Preview aperta" : "Apri preview"}
                    onClick={(e) => {
                      e.stopPropagation();
                      openAssetPreview(asset);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                  <span class={`asset-item-badge asset-item-badge--${asset.kind}`}>{asset.kind.toUpperCase()}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={previewAsset()}>
          <div class="asset-preview-pane asset-preview-pane--fixed">
            <div class="asset-preview-header">
              <span class="asset-preview-title">{previewAsset()?.label || "Preview"}</span>
              <button type="button" class="asset-preview-close" title="Chiudi preview" onClick={closeAssetPreview}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div class="asset-preview-body">
              <Show when={previewSrc()} fallback={<div class="asset-preview-empty">Seleziona un asset</div>}>
                {(() => {
                  const src = previewSrc();
                  const asset = previewAsset();
                  if (!src || !asset) return null;
                  if (asset.kind === "video") return <video class="asset-preview-media" src={src} controls preload="metadata" />;
                  return <audio class="asset-preview-media asset-preview-audio" src={src} controls preload="metadata" />;
                })()}
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <div class="sidebar-tab-body sidebar-tab-body--logs" style={{ display: activeTab() === "logs" ? "flex" : "none" }}>
        <div class="sidebar-logs-content">
          <For each={[...logs()].reverse()}>
            {(line) => <div class="sidebar-log-line">{line}</div>}
          </For>
        </div>
      </div>
    </div>
  );
};

const FileTypeIcon: Component<{ type: "video" | "audio" }> = (props) => (
  <svg class={`asset-type-icon asset-type-icon--${props.type}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d={props.type === "video"
      ? "M15 10l5-3v10l-5-3zM4 6h11a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z"
      : "M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"} />
  </svg>
);

const MonitorPanel: Component<{ project: Accessor<EditorialProject | null> }> = (props) => {
  const [gpuStatus, setGpuStatus] = createSignal<"ready" | "fallback" | "unsupported">("unsupported");
  const [codecStatus, setCodecStatus] = createSignal<"ready" | "unsupported">("unsupported");
  const [stageSize, setStageSize] = createSignal({ width: 0, height: 0 });
  const [transportPlaying, setTransportPlaying] = createSignal(false);
  let stageRef: HTMLDivElement | undefined;
  let canvasRef: HTMLCanvasElement | undefined;
  let playbackVideoRef: HTMLVideoElement | undefined;
  let decoderVideoRef: HTMLVideoElement | undefined;
  const audioRefs = new Map<string, HTMLAudioElement>();
  let gpuContext: any;
  let gpuDevice: any;
  let gpuPipeline: any;
  let sampler: any;
  let layoutBuffer: any;
  let raf = 0;
  let transportStartAt = 0;
  let transportStartTime = 0;
  let videoFrameCallbackHandle: number | null = null;
  let videoWarmupToken = 0;
  const desiredMediaTimes = new WeakMap<HTMLMediaElement, number>();

  const project = () => props.project();
  const frameRate = createMemo(() => Math.max(1, project()?.sequence.fps ?? 30));
  const contentDuration = createMemo(() => (project() ? projectDuration(project()!) : 0));
  const sequenceWidth = createMemo(() => Math.max(1, Math.round(project()?.sequence.width ?? 1080)));
  const sequenceHeight = createMemo(() => Math.max(1, Math.round(project()?.sequence.height ?? 1920)));
  const displayFrame = createMemo(() => {
    const width = stageSize().width;
    const height = stageSize().height;
    if (width <= 0 || height <= 0) {
      return { width: sequenceWidth(), height: sequenceHeight() };
    }
    const scale = Math.min(width / sequenceWidth(), height / sequenceHeight());
    return {
      width: Math.max(1, Math.floor(sequenceWidth() * scale)),
      height: Math.max(1, Math.floor(sequenceHeight() * scale)),
    };
  });
  const activeVideoClip = createMemo(() => {
    const current = project();
    if (!current) return null;
    const at = playheadTime();
    const trackOrder = new Map(current.tracks.map((track) => [track.id, track.order]));
    return [...current.clips]
      .filter((clip) => {
        const track = getTrack(current, clip.track_id);
        return clip.enabled
          && track?.kind === "video"
          && track.visible
          && clip.start <= at
          && (clip.start + (clip.source_out - clip.source_in)) >= at;
      })
      .sort((a, b) =>
        ((trackOrder.get(a.track_id) ?? 0) - (trackOrder.get(b.track_id) ?? 0))
        || (b.z_index - a.z_index)
        || (a.start - b.start)
      )[0] ?? null;
  });
  const activeVideoAsset = createMemo(() => {
    const current = project();
    const clip = activeVideoClip();
    if (!current || !clip) return null;
    return assetById(current, clip.asset_id) ?? null;
  });
  const activeAudioClips = createMemo(() => {
    const current = project();
    if (!current) return [] as TimelineClip[];
    const at = playheadTime();
    const trackOrder = new Map(current.tracks.map((track) => [track.id, track.order]));
    return [...current.clips]
      .filter((clip) => {
        const track = getTrack(current, clip.track_id);
        return clip.enabled
          && track?.kind === "audio"
          && !track.muted
          && !clip.audio.muted
          && clip.start <= at
          && (clip.start + (clip.source_out - clip.source_in)) >= at;
      })
      .sort((a, b) =>
        ((trackOrder.get(a.track_id) ?? 0) - (trackOrder.get(b.track_id) ?? 0))
        || (a.start - b.start)
      );
  });
  const monitorAudioClips = createMemo(() => {
    const current = project();
    if (!current) return [] as TimelineClip[];
    const at = playheadTime();
    const trackOrder = new Map(current.tracks.map((track) => [track.id, track.order]));
    return [...current.clips]
      .filter((clip) => {
        const track = getTrack(current, clip.track_id);
        if (!clip.enabled || track?.kind !== "audio" || track.muted || clip.audio.muted) return false;
        const clipEnd = clip.start + (clip.source_out - clip.source_in);
        return clipEnd >= (at - AUDIO_PREWARM_TRAIL_SECONDS)
          && clip.start <= (at + AUDIO_PREWARM_LEAD_SECONDS);
      })
      .sort((a, b) =>
        ((trackOrder.get(a.track_id) ?? 0) - (trackOrder.get(b.track_id) ?? 0))
        || (a.start - b.start)
      );
  });
  const mediaSource = (clip: TimelineClip | null) => {
    const current = project();
    const jobId = selectedJobId();
    if (!current || !jobId || !clip) return null;
    const asset = assetById(current, clip.asset_id);
    return asset ? fileUrl(jobId, asset.path) : null;
  };
  const mediaSourceForClip = (clip: TimelineClip) => mediaSource(clip);
  const normalizeMediaSource = (src: string) => {
    try {
      return new URL(src, window.location.href).href;
    } catch {
      return src;
    }
  };
  const mediaElementHasSource = (
    element: HTMLMediaElement | undefined,
    src: string | null,
  ) => {
    if (!element || !src) return false;
    const expected = normalizeMediaSource(src);
    const current = element.currentSrc || element.getAttribute("src") || "";
    return normalizeMediaSource(current) === expected;
  };
  const activeVideoSource = createMemo(() => mediaSource(activeVideoClip()));
  const activeVideoSourceKey = createMemo(() => {
    const clip = activeVideoClip();
    const src = activeVideoSource();
    return clip && src ? `${clip.id}:${src}` : null;
  });
  const monitorDuration = createMemo(() => Math.max(0, contentDuration()));
  const monitorPlayhead = createMemo(() => Math.max(0, Math.min(playheadTime(), monitorDuration())));
  const monitorHasMedia = createMemo(() => monitorDuration() > 0);
  const monitorProgressPercent = createMemo(() =>
    monitorDuration() > 0 ? (monitorPlayhead() / monitorDuration()) * 100 : 0
  );
  const syncClipTime = (clip: TimelineClip | null, element: HTMLMediaElement | undefined) => {
    if (!clip || !element) return;
    const localTime = clip.source_in + Math.max(0, playheadTime() - clip.start);
    desiredMediaTimes.set(element, localTime);
    if (element.readyState < 1) return;
    if (element.seeking) return;
    try {
      if (Math.abs(element.currentTime - localTime) > 0.08) element.currentTime = localTime;
    } catch {
      // Media can reject seeks before metadata is fully ready; tick will retry.
    }
  };
  const syncAudioClipTime = (
    clip: TimelineClip | null,
    element: HTMLAudioElement | undefined,
    mode: "soft" | "force" = "soft",
  ) => {
    if (!clip || !element) return;
    const localTime = clip.source_in + Math.max(0, playheadTime() - clip.start);
    desiredMediaTimes.set(element, localTime);
    if (element.readyState < 1) return;
    if (element.seeking) return;
    const drift = Math.abs(element.currentTime - localTime);
    const threshold = mode === "force"
      ? 0.02
      : (transportPlaying() && !element.paused ? 0.35 : 0.1);
    try {
      if (drift > threshold) element.currentTime = localTime;
    } catch {
      // Media can reject seeks before metadata is fully ready; tick will retry.
    }
  };
  const settleClipTime = (clip: TimelineClip | null, element: HTMLMediaElement | undefined) => {
    if (!clip || !element) return;
    if (element.readyState < 1 || element.seeking) return;
    const target = desiredMediaTimes.get(element);
    if (target === undefined) return;
    try {
      if (Math.abs(element.currentTime - target) > 0.04) element.currentTime = target;
    } catch {
      // Ignore late seek reconciliation errors.
    }
  };
  const pausePlayback = () => {
    transportStartTime = playheadTime();
    setTransportPlaying(false);
    playbackVideoRef?.pause();
    for (const element of audioRefs.values()) element.pause();
  };
  const playMediaElement = (element: HTMLMediaElement | undefined) => {
    if (!element || element.readyState < 2 || !element.paused) return;
    void element.play().catch(() => {});
  };
  const clearVideoFrameCallback = () => {
    if (!decoderVideoRef || videoFrameCallbackHandle === null || !("cancelVideoFrameCallback" in decoderVideoRef)) return;
    try {
      (
        decoderVideoRef as HTMLVideoElement & {
          cancelVideoFrameCallback?: (handle: number) => void;
        }
      ).cancelVideoFrameCallback?.(videoFrameCallbackHandle);
    } catch {
      // Ignore cancellation errors during source swaps.
    }
    videoFrameCallbackHandle = null;
  };
  const scheduleVideoFrameProbe = () => {
    const video = decoderVideoRef as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }) | undefined;
    if (!video || !("requestVideoFrameCallback" in video)) return;
    clearVideoFrameCallback();
    try {
      videoFrameCallbackHandle = video.requestVideoFrameCallback?.(() => {
        videoFrameCallbackHandle = null;
        if (gpuStatus() === "ready") requestAnimationFrame(drawFrame);
      }) ?? null;
    } catch {
      videoFrameCallbackHandle = null;
    }
  };
  const requestVideoFrameDraw = () => {
    if (!decoderVideoRef) return;
    scheduleVideoFrameProbe();
    if (gpuStatus() === "ready") requestAnimationFrame(drawFrame);
  };
  const warmVideoFrame = () => {
    const video = decoderVideoRef;
    const clip = activeVideoClip();
    if (!video || !clip || transportPlaying() || video.readyState < 2) return;
    const token = ++videoWarmupToken;
    syncClipTime(clip, video);
    const settle = () => {
      if (token !== videoWarmupToken) return;
      video.pause();
      syncClipTime(activeVideoClip(), decoderVideoRef);
      requestVideoFrameDraw();
    };
    const playAttempt = video.play();
    if (!playAttempt || typeof playAttempt.then !== "function") {
      settle();
      return;
    }
    void playAttempt
      .then(() => {
        requestAnimationFrame(() => {
          settle();
        });
      })
      .catch(() => {
        settle();
      });
  };
  const syncTransportClock = (time: number) => {
    transportStartAt = performance.now();
    transportStartTime = time;
  };
  const togglePlayback = () => {
    if (transportPlaying()) {
      pausePlayback();
      return;
    }
    const duration = contentDuration();
    const startTime = Math.max(0, Math.min(playheadTime(), duration));
    setPlayheadTime(startTime);
    syncTransportClock(startTime);
    setTransportPlaying(true);
    syncClipTime(activeVideoClip(), playbackVideoRef);
    syncClipTime(activeVideoClip(), decoderVideoRef);
    for (const clip of activeAudioClips()) {
      syncAudioClipTime(clip, audioRefs.get(clip.id), "force");
    }
    playMediaElement(playbackVideoRef);
    for (const clip of activeAudioClips()) {
      playMediaElement(audioRefs.get(clip.id));
    }
  };
  const stepFrame = (direction: -1 | 1) => {
    pausePlayback();
    const next = Math.max(0, Math.min(monitorDuration(), playheadTime() + direction / frameRate()));
    setSeekRequest(next);
  };
  const scrubMonitor = (time: number) => {
    setSeekRequest(Math.max(0, Math.min(monitorDuration(), time)));
  };
  const initGpu = async () => {
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!canvasRef || !gpu) {
      setGpuStatus("unsupported");
      return;
    }
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        setGpuStatus("unsupported");
        return;
      }
      gpuDevice = await adapter.requestDevice();
      gpuContext = canvasRef.getContext("webgpu") ?? undefined;
      if (!gpuContext || !gpuDevice) {
        setGpuStatus("fallback");
        return;
      }
      gpuContext.configure({
        device: gpuDevice,
        format: gpu.getPreferredCanvasFormat(),
        alphaMode: "opaque",
      });
      sampler = gpuDevice.createSampler({ magFilter: "linear", minFilter: "linear" });
      const bufferUsage = (globalThis as { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } }).GPUBufferUsage;
      if (!bufferUsage) {
        setGpuStatus("fallback");
        return;
      }
      layoutBuffer = gpuDevice.createBuffer({
        size: 16,
        usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST,
      });
      gpuPipeline = gpuDevice.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: gpuDevice.createShaderModule({
            code: `
              struct FrameLayout {
                scale: vec2f,
                pad: vec2f,
              };
              struct Out {
                @builtin(position) pos: vec4f,
                @location(0) uv: vec2f,
              };
              @group(0) @binding(0) var<uniform> frameLayout: FrameLayout;
              @vertex
              fn main(@builtin(vertex_index) i: u32) -> Out {
                var pos = array<vec2f, 6>(
                  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
                );
                var uv = array<vec2f, 6>(
                  vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
                  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
                );
                var out: Out;
                out.pos = vec4f(pos[i] * frameLayout.scale, 0.0, 1.0);
                out.uv = uv[i];
                return out;
              }
            `,
          }),
          entryPoint: "main",
        },
        fragment: {
          module: gpuDevice.createShaderModule({
            code: `
              @group(0) @binding(1) var frameSampler: sampler;
              @group(0) @binding(2) var frameTex: texture_external;
              @fragment
              fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
                return textureSampleBaseClampToEdge(frameTex, frameSampler, uv);
              }
            `,
          }),
          entryPoint: "main",
          targets: [{ format: gpu.getPreferredCanvasFormat() }],
        },
        primitive: { topology: "triangle-list" },
      });
      setGpuStatus("ready");
    } catch {
      setGpuStatus("fallback");
    }
  };

  const drawFrame = () => {
    const video = decoderVideoRef;
    if (
      !canvasRef
      || !video
      || !gpuDevice
      || !gpuContext
      || !gpuPipeline
      || !sampler
      || !layoutBuffer
      || video.readyState < 2
    ) return;
    try {
      const asset = activeVideoAsset();
      const [scaleX, scaleY] = containScale(
        video.videoWidth || asset?.width || sequenceWidth(),
        video.videoHeight || asset?.height || sequenceHeight(),
        sequenceWidth(),
        sequenceHeight(),
      );
      gpuDevice.queue.writeBuffer(layoutBuffer, 0, new Float32Array([scaleX, scaleY, 0, 0]));
      const texture = gpuDevice.importExternalTexture({ source: video });
      const bindGroup = gpuDevice.createBindGroup({
        layout: gpuPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: layoutBuffer } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: texture },
        ],
      });
      const encoder = gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: gpuContext.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(gpuPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
      gpuDevice.queue.submit([encoder.finish()]);
    } catch {
      setGpuStatus("fallback");
    }
  };

  const tick = () => {
    if (transportPlaying()) {
      const duration = contentDuration();
      const elapsed = (performance.now() - transportStartAt) / 1000;
      const nextTime = transportStartTime + elapsed;
      if (nextTime >= duration) {
        setPlayheadTime(duration);
        pausePlayback();
      } else {
        setPlayheadTime(nextTime);
      }
    }
    const clip = activeVideoClip();
    if (clip) {
      syncClipTime(clip, playbackVideoRef);
      syncClipTime(clip, decoderVideoRef);
    } else {
      playbackVideoRef?.pause();
      decoderVideoRef?.pause();
    }
    const activeAudioIds = new Set(activeAudioClips().map((item) => item.id));
    for (const audioClip of activeAudioClips()) {
      const element = audioRefs.get(audioClip.id);
      if (!element) continue;
      element.volume = Math.max(0, Math.min(1, audioClip.audio.gain));
      syncAudioClipTime(audioClip, element, "soft");
    }
    for (const [clipId, element] of audioRefs.entries()) {
      if (!activeAudioIds.has(clipId)) element.pause();
    }
    if (transportPlaying()) {
      if (clip) playMediaElement(playbackVideoRef);
      for (const audioClip of activeAudioClips()) {
        playMediaElement(audioRefs.get(audioClip.id));
      }
    }
    raf = requestAnimationFrame(tick);
  };

  createEffect(() => {
    sequenceWidth();
    sequenceHeight();
    if (canvasRef) {
      canvasRef.width = sequenceWidth();
      canvasRef.height = sequenceHeight();
    }
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (gpuContext && gpuDevice && gpu) {
      gpuContext.configure({
        device: gpuDevice,
        format: gpu.getPreferredCanvasFormat(),
        alphaMode: "opaque",
      });
    }
  });

  createEffect(() => {
    if (!stageRef) return;
    const syncStageSize = () => {
      if (!stageRef) return;
      setStageSize({
        width: stageRef.clientWidth,
        height: stageRef.clientHeight,
      });
    };
    syncStageSize();
    const observer = new ResizeObserver(syncStageSize);
    observer.observe(stageRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    void initGpu();
    setCodecStatus("VideoDecoder" in window && "VideoEncoder" in window ? "ready" : "unsupported");
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    const src = activeVideoSource();
    const key = activeVideoSourceKey();
    if (!playbackVideoRef && !decoderVideoRef) return;
    videoWarmupToken += 1;
    clearVideoFrameCallback();
    if (!src || !key) {
      playbackVideoRef?.pause();
      decoderVideoRef?.pause();
      return;
    }
    if (playbackVideoRef) {
      if (mediaElementHasSource(playbackVideoRef, src)) {
        syncClipTime(activeVideoClip(), playbackVideoRef);
      } else {
        playbackVideoRef.pause();
        playbackVideoRef.removeAttribute("src");
        playbackVideoRef.load();
        playbackVideoRef.src = src;
        playbackVideoRef.load();
      }
    }
    if (decoderVideoRef) {
      if (mediaElementHasSource(decoderVideoRef, src)) {
        syncClipTime(activeVideoClip(), decoderVideoRef);
        requestVideoFrameDraw();
        warmVideoFrame();
      } else {
        decoderVideoRef.pause();
        decoderVideoRef.removeAttribute("src");
        decoderVideoRef.load();
        decoderVideoRef.src = src;
        decoderVideoRef.load();
      }
    }
  });
  createEffect(() => {
    const mountedIds = new Set(monitorAudioClips().map((clip) => clip.id));
    for (const [clipId, element] of audioRefs.entries()) {
      if (mountedIds.has(clipId)) continue;
      element.pause();
      audioRefs.delete(clipId);
    }
    for (const clip of monitorAudioClips()) {
      const element = audioRefs.get(clip.id);
      const src = mediaSourceForClip(clip);
      if (!element || !src) continue;
      const track = project() ? getTrack(project()!, clip.track_id) : null;
      if (!mediaElementHasSource(element, src)) {
        element.src = src;
        element.load();
      }
      element.volume = Math.max(0, Math.min(1, clip.audio.gain));
      element.muted = !!clip.audio.muted || !!track?.muted;
    }
  });

  createEffect(
    on(seekRequest, (time) => {
      if (time === null) return;
      setPlayheadTime(time);
      if (transportPlaying()) syncTransportClock(time);
      syncClipTime(activeVideoClip(), playbackVideoRef);
      syncClipTime(activeVideoClip(), decoderVideoRef);
      for (const clip of activeAudioClips()) {
        syncAudioClipTime(clip, audioRefs.get(clip.id), "force");
      }
      setSeekRequest(null);
    }),
  );
  createEffect(
    on(playPauseRequest, () => {
      togglePlayback();
    }, { defer: true }),
  );
  createEffect(
    on(frameStepRequest, (dir) => {
      if (!dir) return;
      pausePlayback();
      const next = Math.max(0, playheadTime() + dir / frameRate());
      setSeekRequest(next);
      setFrameStepRequest(0);
    }),
  );
  onCleanup(() => {
    clearVideoFrameCallback();
  });

  return (
    <div class="panel monitor-panel">
      <div class="panel-header">
        <span class="panel-title">Monitor</span>
        <div class="monitor-capabilities">
          <span class={`monitor-capability monitor-capability--${gpuStatus()}`}>WebGPU {gpuStatus()}</span>
          <span class={`monitor-capability monitor-capability--${codecStatus()}`}>WebCodecs {codecStatus()}</span>
        </div>
      </div>
      <div ref={stageRef} class="monitor-stage">
        <div
          class="monitor-frame"
          style={{
            width: `${displayFrame().width}px`,
            height: `${displayFrame().height}px`,
          }}
        >
          <canvas
            ref={canvasRef}
            class="monitor-canvas"
            width={sequenceWidth()}
            height={sequenceHeight()}
          />
          <video
            ref={playbackVideoRef}
            controls
            preload="auto"
            muted
            playsinline
            class="monitor-fallback-video"
            style={{ display: activeVideoSource() ? "block" : "none" }}
            onLoadedMetadata={() => {
              syncClipTime(activeVideoClip(), playbackVideoRef);
            }}
            onLoadedData={() => {
              syncClipTime(activeVideoClip(), playbackVideoRef);
              if (transportPlaying()) playMediaElement(playbackVideoRef);
            }}
            onCanPlay={() => {
              syncClipTime(activeVideoClip(), playbackVideoRef);
              if (transportPlaying()) playMediaElement(playbackVideoRef);
            }}
            onSeeked={() => {
              settleClipTime(activeVideoClip(), playbackVideoRef);
              if (transportPlaying()) playMediaElement(playbackVideoRef);
            }}
          />
          <video
            ref={decoderVideoRef}
            preload="auto"
            muted
            playsinline
            class="monitor-decoder-video"
            aria-hidden="true"
            tabindex={-1}
            onLoadedMetadata={() => {
              syncClipTime(activeVideoClip(), decoderVideoRef);
              requestVideoFrameDraw();
              warmVideoFrame();
            }}
            onLoadedData={() => {
              syncClipTime(activeVideoClip(), decoderVideoRef);
              requestVideoFrameDraw();
            }}
            onCanPlay={() => {
              syncClipTime(activeVideoClip(), decoderVideoRef);
              requestVideoFrameDraw();
            }}
            onSeeked={() => {
              settleClipTime(activeVideoClip(), decoderVideoRef);
              requestVideoFrameDraw();
            }}
          />
        </div>
        <div class="monitor-audio hidden" aria-hidden="true">
          <For each={monitorAudioClips()}>
            {(clip) => (
              <audio
                ref={(element) => {
                  if (!element) return;
                  audioRefs.set(clip.id, element);
                }}
                preload="auto"
                style={{ display: "none" }}
                onLoadedData={(event) => {
                  const element = event.currentTarget;
                  audioRefs.set(clip.id, element);
                  syncAudioClipTime(clip, element, "force");
                  if (activeAudioClips().some((item) => item.id === clip.id) && transportPlaying()) {
                    playMediaElement(element);
                  }
                }}
                onCanPlay={(event) => {
                  const element = event.currentTarget;
                  audioRefs.set(clip.id, element);
                  syncAudioClipTime(clip, element, "force");
                  if (activeAudioClips().some((item) => item.id === clip.id) && transportPlaying()) {
                    playMediaElement(element);
                  }
                }}
                onSeeked={(event) => {
                  const element = event.currentTarget;
                  settleClipTime(clip, element);
                  if (activeAudioClips().some((item) => item.id === clip.id) && transportPlaying()) {
                    playMediaElement(element);
                  }
                }}
              />
            )}
          </For>
        </div>
      </div>
      <div class="monitor-controls-shell">
        <div class="monitor-controls">
          <div class="monitor-scrubber-row">
            <input
              class="monitor-scrubber"
              type="range"
              min="0"
              max={Math.max(monitorDuration(), 0.001)}
              step="0.01"
              value={monitorPlayhead()}
              aria-label="Posizione riproduzione"
              disabled={!monitorHasMedia()}
              style={{
                background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${monitorProgressPercent()}%, rgba(255,255,255,0.12) ${monitorProgressPercent()}%, rgba(255,255,255,0.12) 100%)`,
              }}
              onInput={(event) => scrubMonitor(Number(event.currentTarget.value))}
            />
          </div>
          <div class="monitor-controls-row">
            <div class="monitor-timecodes monitor-timecodes--left" aria-live="off">
              <span class="monitor-timecode">{fmtTimePrecise(monitorPlayhead())}</span>
            </div>
            <div class="monitor-transport">
              <button
                type="button"
                class="monitor-control-btn"
                title="Vai all'inizio"
                aria-label="Vai all'inizio"
                disabled={!monitorHasMedia()}
                onClick={() => scrubMonitor(0)}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M3 3.5h1.5v9H3zM5.5 8l7 4.5v-9z" />
                </svg>
              </button>
              <button
                type="button"
                class="monitor-control-btn"
                title="Frame precedente"
                aria-label="Frame precedente"
                disabled={!monitorHasMedia()}
                onClick={() => stepFrame(-1)}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12.5 3.5L6 8l6.5 4.5v-9z" />
                  <path d="M3.5 3.5v9" />
                </svg>
              </button>
              <button
                type="button"
                class="monitor-control-btn monitor-control-btn--primary"
                title={transportPlaying() ? "Pausa" : "Play"}
                aria-label={transportPlaying() ? "Pausa" : "Play"}
                disabled={!monitorHasMedia()}
                onClick={togglePlayback}
              >
                <Show
                  when={transportPlaying()}
                  fallback={
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M5 3.25v9.5L12.5 8 5 3.25z" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" />
                  </svg>
                </Show>
              </button>
              <button
                type="button"
                class="monitor-control-btn"
                title="Frame successivo"
                aria-label="Frame successivo"
                disabled={!monitorHasMedia()}
                onClick={() => stepFrame(1)}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3.5 3.5L10 8l-6.5 4.5v-9z" />
                  <path d="M12.5 3.5v9" />
                </svg>
              </button>
              <button
                type="button"
                class="monitor-control-btn"
                title="Vai alla fine"
                aria-label="Vai alla fine"
                disabled={!monitorHasMedia()}
                onClick={() => scrubMonitor(monitorDuration())}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M10.5 8L3.5 3.5v9zM11.5 3.5h1.5v9h-1.5z" />
                </svg>
              </button>
            </div>
            <div class="monitor-timecodes monitor-timecodes--right" aria-live="off">
              <span class="monitor-timecode monitor-timecode--total">{fmtTimePrecise(monitorDuration())}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const TimelinePanel: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: ProjectUpdater) => void;
}> = (props) => {
  const job = useJobQuery(selectedJobId);
  const queryClient = useQueryClient();
  const requestAssetPreviews = useRequestAssetPreviewsMutation();
  const transcribeLaneMut = useTranscribeLaneMutation();
  const requestedPreviewAssetIds = new Set<string>();
  const [dragPreview, setDragPreview] = createSignal<{
    assetId: string;
    start: number;
    label: string;
    duration: number;
    trackIds: string[];
  } | null>(null);
  const project = () => props.project();
  const [zoomIdx, setZoomIdx] = createSignal(1);
  const zoom = () => ZOOM_STEPS[zoomIdx()];
  const pxPerSecond = () => MIN_PX_PER_SEC * zoom();
  const [viewportLeft, setViewportLeft] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(1);
  let zoomWheelAccumulator = 0;
  let zoomWheelResetHandle: ReturnType<typeof setTimeout> | undefined;
  let rulerViewportRef: HTMLDivElement | undefined;
  let rulerInnerRef: HTMLDivElement | undefined;
  let assetViewportRef: HTMLDivElement | undefined;
  let audioViewportRef: HTMLDivElement | undefined;
  let assetLabelsRef: HTMLDivElement | undefined;
  let audioLabelsRef: HTMLDivElement | undefined;
  let assetInnerRef: HTMLDivElement | undefined;
  let audioInnerRef: HTMLDivElement | undefined;
  let horizontalSyncHandle: number | undefined;
  let verticalSyncHandle: number | undefined;
  let syncingHorizontal = false;
  let syncingVertical = false;
  let activeHorizontalSource: HTMLDivElement | null = null;
  let activeVerticalSource: HTMLDivElement | null = null;
  let didInitMirroredVertical = false;
  const actualDuration = createMemo(() => (project() ? projectDuration(project()!) : 0));
  const tailDuration = createMemo(() =>
    Math.min(
      TIMELINE_TAIL_MAX_SECONDS,
      Math.max(TIMELINE_TAIL_MIN_SECONDS, actualDuration() * TIMELINE_TAIL_RATIO),
    )
  );
  const duration = createMemo(() => Math.max(TIMELINE_TAIL_MIN_SECONDS, actualDuration() + tailDuration()));
  const timelineWidth = () => Math.max(400, duration() * pxPerSecond());
  const contentWidth = () => Math.max(timelineWidth(), viewportWidth());
  const toPx = (seconds: number) => seconds * pxPerSecond();
  const pxToSec = (px: number) => Math.max(0, Math.min(duration(), px / pxPerSecond()));
  const tracks = createMemo(() => (project() ? sortedTracks(project()!) : []));
  const assetTracks = createMemo(() => tracks().filter((track) => track.kind !== "audio"));
  const audioTracks = createMemo(() => tracks().filter((track) => track.kind === "audio"));
  const captionHostTrackId = createMemo(() => {
    const current = project();
    return current ? subtitleTrack(current)?.id ?? null : null;
  });
  const runningSubtitleLaneIds = createMemo(() => new Set(
    (project()?.lane_transcriptions ?? [])
      .filter((lane) => lane.status === "running")
      .map((lane) => lane.lane_id),
  ));
  const pendingSubtitleRanges = createMemo(() => {
    const current = project();
    const hostTrackId = captionHostTrackId();
    if (!current || !hostTrackId) return [];
    return current.lane_transcriptions.flatMap((lane) => {
      if (lane.status !== "running") return [];
      const range = laneContentRange(current, lane.lane_id);
      if (!range || range.end <= range.start) return [];
      const sourceTrack = getTrack(current, lane.lane_id);
      return [{
        id: `subtitle_pending_${lane.lane_id}`,
        trackId: hostTrackId,
        start: range.start,
        end: range.end,
        label: sourceTrack ? `AI TRANSCRIPTION / ${sourceTrack.name}` : "AI TRANSCRIPTION",
      }];
    });
  });
  const visibleTrackSubtitles = (trackId: string) =>
    trackSubtitles(project()!, trackId).filter((caption) => !(
      runningSubtitleLaneIds().has(caption.source_lane_id) && caption.origin === "generated"
    ));
  const selectTrack = (trackId: string) => {
    setSelectedTrackId(trackId);
    setSelectedClipId(null);
    setSelectedSubtitleId(null);
  };
  const updateTrack = (trackId: string, patch: Partial<TimelineTrack>) => {
    props.updateProject((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (
        track.id === trackId ? { ...track, ...patch } : track
      )),
    }));
  };
  const laneClipCount = (trackId: string) => (project() ? trackClips(project()!, trackId).length : 0);
  const laneTranscriptionStatus = (trackId: string) =>
    project()?.lane_transcriptions.find((lane) => lane.lane_id === trackId)?.status ?? "idle";
  const canTranscribeLane = (track: TimelineTrack) =>
    track.kind === "audio"
    && !!selectedJobId()
    && !!job.data
    && job.data.status !== "running"
    && laneClipCount(track.id) > 0
    && laneTranscriptionStatus(track.id) !== "running";
  const triggerLaneSubtitles = (trackId: string) => {
    const jobId = selectedJobId();
    if (!jobId) return;
    transcribeLaneMut.mutate({ jobId, laneId: trackId });
  };
  const subtitleButtonTitle = (trackId: string) => {
    const status = laneTranscriptionStatus(trackId);
    if (laneClipCount(trackId) <= 0) return "Lane vuota";
    if (status === "running") return "Generazione sottotitoli in corso";
    if (status === "completed") return "Rigenera i sottotitoli per questa lane";
    if (status === "failed") return "Riprova a generare i sottotitoli per questa lane";
    return "Genera sottotitoli da questa lane audio";
  };
  const viewportFrac = createMemo(() => {
    const visible = Math.min(viewportWidth(), contentWidth());
    return Math.max(visible / Math.max(contentWidth(), 1), 0);
  });
  const scrollFrac = createMemo(() => {
    const maxScroll = Math.max(contentWidth() - viewportWidth(), 0);
    return maxScroll > 0 ? viewportLeft() / maxScroll : 0;
  });
  const minimapViewportFrac = createMemo(() => Math.min(viewportFrac(), 1));
  const minimapViewportLeftFrac = createMemo(() => scrollFrac() * Math.max(1 - minimapViewportFrac(), 0));
  const rulerScale = createMemo(() => {
    const minorStep = RULER_MINOR_STEPS.find((step) => step * pxPerSecond() >= RULER_MINOR_TARGET_PX)
      ?? RULER_MINOR_STEPS[RULER_MINOR_STEPS.length - 1];
    return {
      minorStep,
      labelStep: minorStep * RULER_LABEL_EVERY_N_TICKS,
    };
  });
  const rulerTicks = createMemo(() => {
    const ticks: Array<{ time: number; labeled: boolean; label: string | null }> = [];
    const { minorStep, labelStep } = rulerScale();
    const count = Math.ceil(duration() / minorStep);
    for (let index = 0; index <= count; index += 1) {
      const time = Number((index * minorStep).toFixed(4));
      const labeled = index % RULER_LABEL_EVERY_N_TICKS === 0;
      ticks.push({
        time,
        labeled,
        label: labeled ? formatRulerLabel(time, labelStep) : null,
      });
    }
    return ticks;
  });
  const selectedClip = createMemo(() => project() ? getClip(project()!, selectedClipId()) : null);
  const selectedLinkedGroupId = createMemo(() => selectedClip()?.linked_group_id ?? null);
  const selectedSubtitle = createMemo(() =>
    project() ? getSubtitleBlock(project()!, selectedSubtitleId()) : null
  );
  const visiblePreviewState = createMemo(() => {
    const current = project();
    if (!current) return { assetIds: [] as string[], hasGenerating: false };
    const visibleStart = viewportLeft();
    const visibleEnd = visibleStart + viewportWidth();
    const nextIds = new Set<string>();
    let hasGenerating = false;

    for (const track of [...assetTracks(), ...audioTracks()]) {
      const previewKind = track.kind === "audio" ? "audio" : "video";
      for (const clip of trackClips(current, track.id)) {
        const clipWidth = Math.max(8, (clip.source_out - clip.source_in) * pxPerSecond());
        if (clipWidth < CLIP_PREVIEW_MIN_WIDTH_PX) continue;
        const clipLeft = toPx(clip.start);
        const clipRight = clipLeft + clipWidth;
        if (clipRight < visibleStart || clipLeft > visibleEnd) continue;
        const asset = assetById(current, clip.asset_id);
        if (!asset) continue;
        if (shouldRequestClipPreview(asset, previewKind)) nextIds.add(asset.id);
        if (hasGeneratingClipPreview(asset, previewKind)) hasGenerating = true;
      }
    }

    return { assetIds: [...nextIds], hasGenerating };
  });
  const horizontalViewports = () =>
    [rulerViewportRef, assetViewportRef, audioViewportRef].filter(Boolean) as HTMLDivElement[];
  const syncViewportMetrics = (source?: HTMLDivElement) => {
    const viewport = source ?? rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
    if (!viewport) return;
    setViewportLeft(viewport.scrollLeft);
    setViewportWidth(viewport.clientWidth);
  };
  const scheduleHorizontalUnlock = () => {
    if (horizontalSyncHandle) cancelAnimationFrame(horizontalSyncHandle);
    horizontalSyncHandle = requestAnimationFrame(() => {
      syncingHorizontal = false;
      activeHorizontalSource = null;
    });
  };
  const scheduleVerticalUnlock = () => {
    if (verticalSyncHandle) cancelAnimationFrame(verticalSyncHandle);
    verticalSyncHandle = requestAnimationFrame(() => {
      syncingVertical = false;
      activeVerticalSource = null;
    });
  };
  const syncHorizontalScroll = (source: HTMLDivElement) => {
    syncViewportMetrics(source);
    if (syncingHorizontal && activeHorizontalSource !== source) return;
    syncingHorizontal = true;
    activeHorizontalSource = source;
    const nextLeft = source.scrollLeft;
    for (const viewport of horizontalViewports()) {
      if (viewport === source) continue;
      if (Math.abs(viewport.scrollLeft - nextLeft) > 0.5) viewport.scrollLeft = nextLeft;
    }
    syncViewportMetrics(source);
    scheduleHorizontalUnlock();
  };
  const syncMirroredVerticalScroll = (group: "asset" | "audio", source: HTMLDivElement) => {
    const ownViewport = group === "asset" ? assetViewportRef : audioViewportRef;
    const ownLabels = group === "asset" ? assetLabelsRef : audioLabelsRef;
    const otherViewport = group === "asset" ? audioViewportRef : assetViewportRef;
    const otherLabels = group === "asset" ? audioLabelsRef : assetLabelsRef;
    const ownTop = source.scrollTop;

    if (ownViewport && ownViewport !== source && Math.abs(ownViewport.scrollTop - ownTop) > 0.5) {
      ownViewport.scrollTop = ownTop;
    }
    if (ownLabels && ownLabels !== source && Math.abs(ownLabels.scrollTop - ownTop) > 0.5) {
      ownLabels.scrollTop = ownTop;
    }
    if (syncingVertical && activeVerticalSource !== source) return;

    syncingVertical = true;
    activeVerticalSource = source;
    const sourceMax = Math.max(source.scrollHeight - source.clientHeight, 0);
    const frac = sourceMax > 0 ? ownTop / sourceMax : 0;
    const otherMax = otherViewport
      ? Math.max(otherViewport.scrollHeight - otherViewport.clientHeight, 0)
      : 0;
    const otherTop = otherMax * (1 - frac);
    if (otherViewport && Math.abs(otherViewport.scrollTop - otherTop) > 0.5) {
      otherViewport.scrollTop = otherTop;
    }
    if (otherLabels && Math.abs(otherLabels.scrollTop - otherTop) > 0.5) {
      otherLabels.scrollTop = otherTop;
    }
    scheduleVerticalUnlock();
  };
  const initializeMirroredVerticalScroll = () => {
    if (didInitMirroredVertical || !assetViewportRef || !audioViewportRef) return;
    const assetMax = Math.max(assetViewportRef.scrollHeight - assetViewportRef.clientHeight, 0);
    if (assetMax > 0) {
      assetViewportRef.scrollTop = assetMax;
      if (assetLabelsRef) assetLabelsRef.scrollTop = assetMax;
    }
    audioViewportRef.scrollTop = 0;
    if (audioLabelsRef) audioLabelsRef.scrollTop = 0;
    didInitMirroredVertical = true;
  };

  const getTimeFromPointer = (clientX: number) => {
    const rect = (rulerInnerRef ?? assetInnerRef ?? audioInnerRef)?.getBoundingClientRect();
    if (!rect) return 0;
    return pxToSec(clientX - rect.left);
  };
  const trackGroupOffset = (kind: "video" | "audio") => {
    const inner = kind === "audio" ? audioInnerRef : assetInnerRef;
    const trackList = kind === "audio" ? audioTracks() : assetTracks();
    if (!inner || !trackList.length || kind === "audio") return 0;
    const totalHeight = trackList.reduce((sum, track) => sum + trackHeight(track.kind), 0);
    return Math.max(0, inner.clientHeight - totalHeight);
  };
  const getTrackFromPointerY = (
    clientY: number,
    kind: "video" | "audio",
  ) => {
    const inner = kind === "audio" ? audioInnerRef : assetInnerRef;
    const trackList = kind === "audio" ? audioTracks() : assetTracks();
    const rect = inner?.getBoundingClientRect();
    if (!rect || clientY < rect.top || clientY > rect.bottom) return null;
    const pointerY = clientY - rect.top;
    let cursor = trackGroupOffset(kind);
    const rows = trackList.map((track) => {
      const top = cursor;
      cursor += trackHeight(track.kind);
      return {
        track,
        top,
        bottom: cursor,
      };
    });
    const hovered = rows.find((row) => pointerY >= row.top && pointerY <= row.bottom)?.track ?? null;
    if (hovered?.kind === kind) return hovered;
    const candidates = rows.filter((row) => row.track.kind === kind);
    if (!candidates.length) return null;
    return candidates.reduce((best, current) => {
      const bestCenter = (best.top + best.bottom) / 2;
      const currentCenter = (current.top + current.bottom) / 2;
      return Math.abs(pointerY - currentCenter) < Math.abs(pointerY - bestCenter) ? current : best;
    }).track;
  };
  const clearDragPreview = () => setDragPreview(null);
  const updateDragPreview = (assetId: string, trackId: string, clientX: number) => {
    const current = project();
    if (!current) return;
    const asset = assetById(current, assetId);
    const track = getTrack(current, trackId);
    if (!asset || !track || !compatibleTrack(asset, track)) {
      clearDragPreview();
      return;
    }
    const start = getTimeFromPointer(clientX);
    const { clips } = createClipsForAssetDrop(current, asset, track, start);
    if (!clips.length) {
      clearDragPreview();
      return;
    }
    setDragPreview({
      assetId,
      start: Math.min(...clips.map((clip) => clip.start)),
      label: asset.label || "Clip",
      duration: Math.max(...clips.map((clip) => Math.max(0.02, clip.source_out - clip.source_in))),
      trackIds: [...new Set(clips.map((clip) => clip.track_id))],
    });
  };
  const setZoomIndex = (nextIdx: number, anchorClientX?: number) => {
    const clamped = Math.max(0, Math.min(ZOOM_STEPS.length - 1, nextIdx));
    if (clamped === zoomIdx()) return;
    const viewport = rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
    const nextPxPerSecond = MIN_PX_PER_SEC * ZOOM_STEPS[clamped];
    const anchorOffset = viewport && anchorClientX !== undefined
      ? anchorClientX - viewport.getBoundingClientRect().left
      : null;
    const anchorTime = viewport && anchorOffset !== null
      ? pxToSec(viewport.scrollLeft + anchorOffset)
      : null;
    setZoomIdx(clamped);
    requestAnimationFrame(() => {
      const nextViewport = rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
      if (!nextViewport || anchorOffset === null || anchorTime === null) {
        syncViewportMetrics();
        return;
      }
      const nextTimelineWidth = Math.max(400, duration() * nextPxPerSecond);
      const nextContentWidth = Math.max(nextTimelineWidth, nextViewport.clientWidth);
      const maxScroll = Math.max(nextContentWidth - nextViewport.clientWidth, 0);
      const nextLeft = (anchorTime * nextPxPerSecond) - anchorOffset;
      const clampedLeft = Math.max(0, Math.min(maxScroll, nextLeft));
      nextViewport.scrollLeft = clampedLeft;
      syncHorizontalScroll(nextViewport);
    });
  };
  const centerViewportAtTime = (time: number) => {
    const viewport = rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
    if (!viewport) return;
    const maxScroll = Math.max(contentWidth() - viewport.clientWidth, 0);
    const nextLeft = toPx(time) - (viewport.clientWidth / 2);
    viewport.scrollLeft = Math.max(0, Math.min(maxScroll, nextLeft));
    syncHorizontalScroll(viewport);
  };
  const onTimelineWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 120 : 1;
    zoomWheelAccumulator += (-event.deltaY * multiplier);
    clearTimeout(zoomWheelResetHandle);
    zoomWheelResetHandle = setTimeout(() => {
      zoomWheelAccumulator = 0;
    }, 220);
    if (Math.abs(zoomWheelAccumulator) < ZOOM_WHEEL_THRESHOLD) return;
    const direction = zoomWheelAccumulator > 0 ? 1 : -1;
    const stepCount = Math.max(1, Math.floor(Math.abs(zoomWheelAccumulator) / ZOOM_WHEEL_THRESHOLD));
    zoomWheelAccumulator -= direction * stepCount * ZOOM_WHEEL_THRESHOLD;
    setZoomIndex(zoomIdx() + (direction * stepCount), event.clientX);
  };
  const onMinimapPointerDown = (event: PointerEvent) => {
    if (!rulerViewportRef && !assetViewportRef && !audioViewportRef) return;
    const target = event.currentTarget as HTMLDivElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const nextTime = duration() * frac;
    centerViewportAtTime(nextTime);
  };
  const beginMinimapViewportDrag = (event: PointerEvent) => {
    if (!rulerViewportRef && !assetViewportRef && !audioViewportRef) return;
    event.preventDefault();
    event.stopPropagation();
    const viewportEl = event.currentTarget as HTMLDivElement | null;
    const contentEl = viewportEl?.parentElement as HTMLDivElement | null;
    if (!viewportEl || !contentEl) return;

    const contentRect = contentEl.getBoundingClientRect();
    const viewportRect = viewportEl.getBoundingClientRect();
    const grabRatio = viewportRect.width > 0
      ? (event.clientX - viewportRect.left) / viewportRect.width
      : 0.5;
    const clickTime = duration() * Math.max(0, Math.min(1, (event.clientX - contentRect.left) / contentRect.width));
    const startX = event.clientX;
    let didDrag = false;

    const updateFromClientX = (clientX: number) => {
      const viewport = rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
      if (!viewport) return;
      const pointerFrac = Math.max(0, Math.min(1, (clientX - contentRect.left) / contentRect.width));
      const visibleFrac = Math.min(viewportFrac(), 1);
      const maxViewportLeft = Math.max(1 - visibleFrac, 0);
      const viewportLeftFrac = Math.max(
        0,
        Math.min(maxViewportLeft, pointerFrac - (grabRatio * visibleFrac)),
      );
      const normalizedScroll = maxViewportLeft > 0 ? viewportLeftFrac / maxViewportLeft : 0;
      const maxScroll = Math.max(contentWidth() - viewport.clientWidth, 0);
      viewport.scrollLeft = normalizedScroll * maxScroll;
      syncHorizontalScroll(viewport);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 2) didDrag = true;
      updateFromClientX(moveEvent.clientX);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (!didDrag) centerViewportAtTime(clickTime);
    };

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const beginClipDrag = (event: PointerEvent, clip: TimelineClip) => {
    event.preventDefault();
    event.stopPropagation();
    const currentProject = project();
    if (!currentProject) return;
    const startX = event.clientX;
    const linked = linkedClips(currentProject, clip.id);
    const anchorTrack = getTrack(currentProject, clip.track_id);
    if (!anchorTrack || anchorTrack.kind === "subtitle") return;
    const dragKind = anchorTrack.kind;
    const anchorStart = Math.min(...linked.map((item) => item.start));
    const origins = new Map(
      linked.map((item) => [item.id, { start: item.start, trackId: item.track_id }]),
    );
    const onMove = (moveEvent: PointerEvent) => {
      const deltaSec = (moveEvent.clientX - startX) / pxPerSecond();
      const desiredStart = Math.max(0, anchorStart + deltaSec);
      const targetTrack = getTrackFromPointerY(moveEvent.clientY, dragKind);
      props.updateProject((current) => {
        const retargeted = targetTrack
          ? retargetClipGroup(current, linked, clip.id, targetTrack.id)
          : linked;
        const resolvedStart = resolveClipGroupStart(
          current,
          retargeted,
          desiredStart,
          linked.map((item) => item.id),
        );
        const resolvedDelta = resolvedStart - anchorStart;
        const nextTrackIds = new Map(retargeted.map((item) => [item.id, item.track_id]));
        const updates = linked.flatMap((item) => {
          const currentClip = getClip(current, item.id);
          const origin = origins.get(item.id);
          if (!currentClip || !origin) return [];
          return [{
            ...currentClip,
            start: Math.max(0, origin.start + resolvedDelta),
            track_id: nextTrackIds.get(item.id) ?? origin.trackId,
          }];
        });
        return upsertClips(current, updates);
      });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const current = project();
      const movedClip = current ? getClip(current, clip.id) : null;
      if (movedClip) setSelectedTrackId(movedClip.track_id);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const beginTrim = (event: PointerEvent, clip: TimelineClip, edge: "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    const linked = linkedClips(project()!, clip.id);
    const draggedOrigin = {
      start: clip.start,
      sourceIn: clip.source_in,
      sourceOut: clip.source_out,
    };
    const origins = new Map(
      linked.map((item) => [
        item.id,
        {
          start: item.start,
          sourceIn: item.source_in,
          sourceOut: item.source_out,
        },
      ]),
    );
    const onMove = (moveEvent: PointerEvent) => {
      const nextTime = getTimeFromPointer(moveEvent.clientX);
      props.updateProject((current) => {
        if (edge === "start") {
          const desiredDelta = nextTime - draggedOrigin.start;
          const resolvedDelta = resolveClipGroupTrimStartDelta(
            current,
            linked,
            desiredDelta,
            linked.map((item) => item.id),
          );
          const updates = linked.flatMap((item) => {
            const currentClip = getClip(current, item.id);
            const origin = origins.get(item.id);
            if (!currentClip || !origin) return [];
            return [{
              ...currentClip,
              start: origin.start + resolvedDelta,
              source_in: origin.sourceIn + resolvedDelta,
            }];
          });
          return upsertClips(current, updates);
        }
        const desiredDelta =
          nextTime - (draggedOrigin.start + (draggedOrigin.sourceOut - draggedOrigin.sourceIn));
        const resolvedDelta = resolveClipGroupTrimEndDelta(
          current,
          linked,
          desiredDelta,
          linked.map((item) => item.id),
        );
        const updates = linked.flatMap((item) => {
          const currentClip = getClip(current, item.id);
          const origin = origins.get(item.id);
          if (!currentClip || !origin) return [];
          return [{
            ...currentClip,
            source_out: origin.sourceOut + resolvedDelta,
          }];
        });
        return upsertClips(current, updates);
      });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const beginRulerScrub = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLDivElement | null;
    const pointerId = event.pointerId;
    const seekToClientX = (clientX: number) => setSeekRequest(getTimeFromPointer(clientX));
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      seekToClientX(moveEvent.clientX);
    };
    const onUp = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      seekToClientX(moveEvent.clientX);
      cleanup();
    };

    seekToClientX(event.clientX);
    target?.setPointerCapture?.(pointerId);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const onRulerScroll = (event: Event) => {
    syncHorizontalScroll(event.currentTarget as HTMLDivElement);
  };
  const onGroupViewportScroll = (group: "asset" | "audio") => (event: Event) => {
    const target = event.currentTarget as HTMLDivElement;
    syncHorizontalScroll(target);
    syncMirroredVerticalScroll(group, target);
  };
  const onGroupLabelsScroll = (group: "asset" | "audio") => (event: Event) => {
    syncMirroredVerticalScroll(group, event.currentTarget as HTMLDivElement);
  };
  const renderTrackLabel = (track: TimelineTrack) => (
    <div
      role="button"
      tabIndex={0}
      class={`tl-label tl-label--dynamic${selectedTrackId() === track.id ? " active" : ""}`}
      style={{ height: `${trackHeight(track.kind)}px` }}
      onClick={() => selectTrack(track.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectTrack(track.id);
      }}
    >
      <div class="tl-lane-card">
        <div class="tl-lane-head">
          <Show when={track.kind === "audio"}>
            <span class="tl-lane-icon tl-lane-icon--audio">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 6v4M5 4v8M8 2v12M11 4v8M14 6v4"/></svg>
            </span>
          </Show>
          <Show when={track.kind === "video"}>
            <span class="tl-lane-icon tl-lane-icon--video">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3.5" width="10" height="9" rx="1.5"/><path d="M11.5 6.5L14.5 4.5v7l-3-2"/></svg>
            </span>
          </Show>
          <span class="tl-lane-name">{track.name}</span>
          <Show when={track.kind === "audio" && track.role}>
            <span class={`tl-lane-meta${track.role === "story" ? " is-story" : ""}`}>
              {track.role === "story" ? "Story" : "Support"}
            </span>
          </Show>
          <Show when={track.kind === "video"}>
            <span class="tl-lane-meta">Canvas</span>
          </Show>
        </div>

        <Show when={track.kind === "audio"}>
          <div class="tl-lane-actions">
            <button
              type="button"
              class={`tl-lane-btn tl-lane-btn--icon tl-lane-btn--subtitle${laneTranscriptionStatus(track.id) === "completed" ? " is-active" : ""}${laneTranscriptionStatus(track.id) === "running" ? " is-running" : ""}`}
              disabled={!canTranscribeLane(track)}
              aria-label={subtitleButtonTitle(track.id)}
              title={subtitleButtonTitle(track.id)}
              onClick={() => triggerLaneSubtitles(track.id)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="14" height="10" rx="2"/><path d="M4 8h3M9 8h3M4 10.5h5"/></svg>
            </button>
            <button
              type="button"
              class={`tl-lane-btn tl-lane-btn--mute${track.muted ? " is-active" : ""}`}
              title={track.muted ? "Riattiva audio lane" : "Metti in muto la lane"}
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
            >
              <Show when={!track.muted} fallback={
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L4 5.5H1.5v5H4L8 14V2z"/><path d="M12 5l-5 6M7 5l5 6"/></svg>
              }>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L4 5.5H1.5v5H4L8 14V2z"/><path d="M11 6.5c.6.7 1 1.6 1 2.5s-.4 1.8-1 2.5"/></svg>
              </Show>
            </button>
          </div>
        </Show>
        <Show when={track.kind === "video"}>
          <div class="tl-lane-actions tl-lane-actions--single">
            <button
              type="button"
              class={`tl-lane-btn tl-lane-btn--icon${track.visible ? " is-active" : ""}`}
              aria-label={track.visible ? "Nascondi dal canvas questa lane video" : "Mostra nel canvas questa lane video"}
              title={track.visible ? "Nascondi dal canvas questa lane video" : "Mostra nel canvas questa lane video"}
              onClick={() => updateTrack(track.id, { visible: !track.visible })}
            >
              <Show when={track.visible} fallback={
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3l12 10M6.5 6.5a2 2 0 002.8 2.8M13.4 10.6C14.4 9.6 15 8.8 15 8c0-2.5-3.1-5-7-5-.8 0-1.6.1-2.3.3M1 8c0 2.5 3.1 5 7 5 .8 0 1.6-.1 2.3-.3"/></svg>
              }>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M1 8c0-2.5 3.1-5 7-5s7 2.5 7 5-3.1 5-7 5-7-2.5-7-5z"/></svg>
              </Show>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
  const renderTrackRow = (track: TimelineTrack) => (
    <div
      class={`tl-track tl-track--project tl-track--${track.kind}`}
      style={{ height: `${trackHeight(track.kind)}px` }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        const assetId = e.dataTransfer?.getData("application/x-fellini-asset");
        if (!assetId) {
          clearDragPreview();
          return;
        }
        updateDragPreview(assetId, track.id, e.clientX);
      }}
      onDragLeave={(e) => {
        const nextTarget = e.relatedTarget;
        if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
        const preview = dragPreview();
        if (preview?.trackIds.includes(track.id)) clearDragPreview();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const current = project();
        if (!current) return;
        const assetId = e.dataTransfer?.getData("application/x-fellini-asset");
        if (!assetId) return;
        const asset = assetById(current, assetId);
        if (!asset || !compatibleTrack(asset, track)) return;
        const start = getTimeFromPointer(e.clientX);
        const { clips, primaryClipId } = createClipsForAssetDrop(current, asset, track, start);
        if (!clips.length || !primaryClipId) return;
        props.updateProject((value) => upsertClips(value, clips));
        clearDragPreview();
        setSelectedTrackId(track.id);
        setSelectedClipId(primaryClipId);
        setSelectedSubtitleId(null);
      }}
    >
      <Show when={dragPreview() && dragPreview()!.trackIds.includes(track.id)}>
        <div class="tl-drop-caret" style={{ left: `${toPx(dragPreview()!.start)}px` }} />
        <div
          class={`tl-seg tl-seg--clip tl-seg--ghost tl-seg--${track.kind}`}
          style={{
            left: `${toPx(dragPreview()!.start)}px`,
            width: `${Math.max(8, dragPreview()!.duration * pxPerSecond())}px`,
          }}
        >
          <div class="tl-clip-preview-body tl-clip-preview-body--placeholder" aria-hidden="true" />
          <div class="tl-clip-footer">
            <span class="tl-clip-label">{dragPreview()!.label}</span>
          </div>
        </div>
      </Show>
      <Show when={track.kind !== "subtitle"}>
        <For each={trackClips(project()!, track.id)}>
          {(clip) => (
            <button
              type="button"
              class={`tl-seg tl-seg--clip tl-seg--${track.kind}${selectedClipId() === clip.id || (selectedLinkedGroupId() && clip.linked_group_id === selectedLinkedGroupId()) ? " is-active" : ""}`}
              style={{
                left: `${toPx(clip.start)}px`,
                width: `${Math.max(8, (clip.source_out - clip.source_in) * pxPerSecond())}px`,
              }}
              onPointerDown={(e) => beginClipDrag(e, clip)}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedClipId(clip.id);
                setSelectedTrackId(track.id);
                setSelectedSubtitleId(null);
              }}
            >
              {(() => {
                const asset = assetById(project()!, clip.asset_id);
                const jobId = selectedJobId();
                const clipWidth = Math.max(8, (clip.source_out - clip.source_in) * pxPerSecond());
                return (
                  <>
                    {asset && jobId && clipWidth >= CLIP_PREVIEW_MIN_WIDTH_PX
                      ? (
                          <TimelineClipPreview
                            jobId={jobId}
                            clip={clip}
                            asset={asset}
                            trackKind={track.kind as "video" | "audio"}
                          />
                        )
                      : <div class="tl-clip-preview-body tl-clip-preview-body--placeholder" aria-hidden="true" />}
                    <div class="tl-clip-footer">
                      <span class="tl-clip-label">{asset?.label || "Clip"}</span>
                    </div>
                  </>
                );
              })()}
              <div class="tl-clip-handle tl-clip-handle--start" onPointerDown={(e) => beginTrim(e, clip, "start")} />
              <div class="tl-clip-handle tl-clip-handle--end" onPointerDown={(e) => beginTrim(e, clip, "end")} />
            </button>
          )}
        </For>
      </Show>
      <Show when={track.id === captionHostTrackId() || track.kind === "subtitle"}>
        <For each={pendingSubtitleRanges().filter((item) => item.trackId === track.id)}>
          {(pending) => (
            <div
              class="tl-seg tl-seg--clip tl-seg--video tl-seg--subtitle-pending"
              style={{
                left: `${toPx(pending.start)}px`,
                width: `${Math.max(18, (pending.end - pending.start) * pxPerSecond())}px`,
              }}
            >
              <div class="tl-subtitle-pending-core">
                <span>{pending.label}</span>
                <div class="tl-subtitle-pending-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
          )}
        </For>
        <For each={visibleTrackSubtitles(track.id)}>
          {(caption) => (
            <button
              type="button"
              class={`tl-seg tl-seg--subtitle${selectedSubtitleId() === caption.id ? " is-active" : ""}`}
              style={{
                left: `${toPx(caption.start)}px`,
                width: `${Math.max(8, (caption.end - caption.start) * pxPerSecond())}px`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedSubtitleId(caption.id);
                setSelectedTrackId(track.id);
                setSelectedClipId(null);
              }}
            >
              <span>{caption.text}</span>
            </button>
          )}
        </For>
      </Show>
    </div>
  );

  createEffect(() => {
    const viewport = rulerViewportRef ?? assetViewportRef ?? audioViewportRef;
    if (!viewport || !autoFollow()) return;
    const px = toPx(playheadTime());
    const vw = viewport.clientWidth;
    if (px < viewport.scrollLeft + 40 || px > viewport.scrollLeft + vw - 40) {
      viewport.scrollLeft = Math.max(0, px - vw / 3);
      syncHorizontalScroll(viewport);
    }
  });
  createEffect(() => {
    timelineWidth();
    contentWidth();
    duration();
    requestAnimationFrame(() => syncViewportMetrics());
  });
  createEffect(() => {
    const viewports = horizontalViewports();
    if (!viewports.length) return;
    syncViewportMetrics(viewports[0]);
    const observer = new ResizeObserver(() => {
      syncViewportMetrics();
      initializeMirroredVerticalScroll();
    });
    viewports.forEach((viewport) => observer.observe(viewport));
    requestAnimationFrame(initializeMirroredVerticalScroll);
    const onAssetDragEnd = () => clearDragPreview();
    window.addEventListener("fellini:asset-drag-end", onAssetDragEnd as EventListener);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("fellini:asset-drag-end", onAssetDragEnd as EventListener);
    });
  });
  createEffect(
    on(
      () => selectedJobId(),
      () => {
        requestedPreviewAssetIds.clear();
      },
    ),
  );
  createEffect(
    on(
      () => selectedJobId(),
      () => {
        didInitMirroredVertical = false;
        requestAnimationFrame(initializeMirroredVerticalScroll);
      },
    ),
  );
  createEffect(() => {
    const jobId = selectedJobId();
    if (!jobId || !project() || job.data?.status === "running") return;
    const nextAssetIds = visiblePreviewState().assetIds.filter(
      (assetId) => !requestedPreviewAssetIds.has(assetId),
    );
    if (!nextAssetIds.length) return;
    nextAssetIds.forEach((assetId) => requestedPreviewAssetIds.add(assetId));
    requestAssetPreviews.mutate({ jobId, assetIds: nextAssetIds });
  });
  createEffect(() => {
    const jobId = selectedJobId();
    if (!jobId || !visiblePreviewState().hasGenerating) return;
    const handle = window.setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["editorial-project", jobId] });
    }, 1500);
    onCleanup(() => window.clearInterval(handle));
  });
  onCleanup(() => {
    clearTimeout(zoomWheelResetHandle);
    if (horizontalSyncHandle) cancelAnimationFrame(horizontalSyncHandle);
    if (verticalSyncHandle) cancelAnimationFrame(verticalSyncHandle);
  });

  return (
    <div class="panel timeline-panel">
      <div class="panel-header">
        <span class="panel-title">Timeline</span>
        <div class="timeline-toolbar">
          <span class="timeline-zoom-label" style={{ "min-width": "60px" }}>{fmtTimePrecise(playheadTime())}</span>
          <button type="button" class={`btn btn-xs ${autoFollow() ? "btn-primary" : "btn-ghost"}`} onClick={() => setAutoFollow(!autoFollow())}>
            Follow
          </button>
          <button type="button" class="btn btn-ghost btn-xs" onClick={() => setZoomIndex(zoomIdx() - 1)}>-</button>
          <span class="timeline-zoom-label">{zoom()}x</span>
          <button type="button" class="btn btn-ghost btn-xs" onClick={() => setZoomIndex(zoomIdx() + 1)}>+</button>
          <Show when={selectedClip()}>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              onClick={() => {
                if (!selectedClip()) return;
                props.updateProject((current) => splitClip(current, selectedClip()!.id, playheadTime()));
              }}
            >
              Split
            </button>
          </Show>
        </div>
      </div>
      <Show when={project()} fallback={<div class="placeholder">Timeline non disponibile</div>}>
        <div class="timeline-shell">
          <div class="timeline-body">
            <div class="tl-label tl-label--ruler" />
            <div
              ref={rulerViewportRef}
              class="timeline-ruler-viewport"
              onWheel={onTimelineWheel}
              onScroll={onRulerScroll}
            >
              <div
                ref={rulerInnerRef}
                class="timeline-scroll-inner"
                style={{ width: `${contentWidth()}px` }}
              >
                <div class="tl-playhead tl-playhead--ruler" style={{ left: `${toPx(playheadTime())}px` }} />
                <div class="tl-ruler" onPointerDown={beginRulerScrub}>
                  <For each={rulerTicks()}>
                    {(tick) => (
                      <>
                        <div class={`tl-ruler-tick${tick.labeled ? " major" : ""}`} style={{ left: `${toPx(tick.time)}px` }} />
                        <Show when={tick.labeled}>
                          <span class="tl-ruler-label" style={{ left: `${toPx(tick.time)}px` }}>{tick.label}</span>
                        </Show>
                      </>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <div
              ref={assetLabelsRef}
              class="tl-labels tl-labels--group tl-labels--assets"
              onScroll={onGroupLabelsScroll("asset")}
            >
              <div class="tl-labels-inner tl-labels-inner--assets">
                <For each={assetTracks()}>{renderTrackLabel}</For>
              </div>
            </div>
            <div
              ref={assetViewportRef}
              class="timeline-viewport timeline-viewport--group timeline-viewport--assets"
              onWheel={onTimelineWheel}
              onScroll={onGroupViewportScroll("asset")}
              onDragLeave={(e) => {
                const nextTarget = e.relatedTarget;
                if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
                clearDragPreview();
              }}
              onDrop={() => clearDragPreview()}
            >
              <div
                ref={assetInnerRef}
                class="timeline-scroll-inner timeline-scroll-inner--assets"
                style={{ width: `${contentWidth()}px` }}
              >
                <div class="tl-playhead tl-playhead--body" style={{ left: `${toPx(playheadTime())}px` }} />
                <For each={assetTracks()}>{renderTrackRow}</For>
              </div>
            </div>

            <div
              ref={audioLabelsRef}
              class="tl-labels tl-labels--group tl-labels--audio"
              onScroll={onGroupLabelsScroll("audio")}
            >
              <div class="tl-labels-inner tl-labels-inner--audio">
                <For each={audioTracks()}>{renderTrackLabel}</For>
              </div>
            </div>
            <div
              ref={audioViewportRef}
              class="timeline-viewport timeline-viewport--group timeline-viewport--audio"
              onWheel={onTimelineWheel}
              onScroll={onGroupViewportScroll("audio")}
              onDragLeave={(e) => {
                const nextTarget = e.relatedTarget;
                if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
                clearDragPreview();
              }}
              onDrop={() => clearDragPreview()}
            >
              <div
                ref={audioInnerRef}
                class="timeline-scroll-inner timeline-scroll-inner--audio"
                style={{ width: `${contentWidth()}px` }}
              >
                <div class="tl-playhead tl-playhead--body" style={{ left: `${toPx(playheadTime())}px` }} />
                <For each={audioTracks()}>{renderTrackRow}</For>
              </div>
            </div>
          </div>
          <div class="tl-minimap" style={{ display: "grid" }}>
            <div class="tl-minimap-label">Overview</div>
            <div class="tl-minimap-content" onPointerDown={onMinimapPointerDown}>
              <For each={project()!.clips}>
                {(clip) => {
                  const track = getTrack(project()!, clip.track_id);
                  return (
                    <div
                      class={`tl-mini-seg tl-mini-seg--${track?.kind ?? "video"}`}
                      style={{
                        left: `${(clip.start / duration()) * 100}%`,
                        width: `${Math.max(0.5, ((clip.source_out - clip.source_in) / duration()) * 100)}%`,
                      }}
                    />
                  );
                }}
              </For>
              <For each={project()!.captions}>
                {(caption) => (
                  <div
                    class="tl-mini-seg tl-mini-seg--subtitle"
                    style={{
                      left: `${(caption.start / duration()) * 100}%`,
                      width: `${Math.max(0.5, ((caption.end - caption.start) / duration()) * 100)}%`,
                    }}
                  />
                )}
              </For>
              <div class="tl-mini-playhead" style={{ left: `${(playheadTime() / duration()) * 100}%` }} />
              <div
                class="tl-mini-viewport"
                style={{
                  left: `${minimapViewportLeftFrac() * 100}%`,
                  width: `${Math.max(minimapViewportFrac() * 100, 1)}%`,
                }}
                onPointerDown={beginMinimapViewportDrag}
              />
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Workspace;
