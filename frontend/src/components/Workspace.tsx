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
import {
  useEditorialProjectQuery,
  useJobPolling,
  useJobQuery,
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

type ProjectUpdater = EditorialProject | ((current: EditorialProject) => EditorialProject);

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
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
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
      () => projectQuery.data?.revision,
      () => {
        if (!projectQuery.data) {
          setDraftProject(null);
          return;
        }
        const normalized = normalizeEditorialProject(
          JSON.parse(JSON.stringify(projectQuery.data)) as EditorialProject,
        );
        setDraftProject(normalized);
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
  const [videoFrameReady, setVideoFrameReady] = createSignal(false);
  let stageRef: HTMLDivElement | undefined;
  let canvasRef: HTMLCanvasElement | undefined;
  let videoRef: HTMLVideoElement | undefined;
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
  const syncClipTime = (clip: TimelineClip | null, element: HTMLMediaElement | undefined) => {
    if (!clip || !element) return;
    const localTime = clip.source_in + Math.max(0, playheadTime() - clip.start);
    if (element.readyState < 1) return;
    try {
      if (Math.abs(element.currentTime - localTime) > 0.12) element.currentTime = localTime;
    } catch {
      // Media can reject seeks before metadata is fully ready; tick will retry.
    }
  };
  const pausePlayback = () => {
    transportStartTime = playheadTime();
    setTransportPlaying(false);
    videoRef?.pause();
    for (const element of audioRefs.values()) element.pause();
  };
  const playMediaElement = (element: HTMLMediaElement | undefined) => {
    if (!element || element.readyState < 2 || !element.paused) return;
    void element.play().catch(() => {});
  };
  const clearVideoFrameCallback = () => {
    if (!videoRef || videoFrameCallbackHandle === null || !("cancelVideoFrameCallback" in videoRef)) return;
    try {
      (
        videoRef as HTMLVideoElement & {
          cancelVideoFrameCallback?: (handle: number) => void;
        }
      ).cancelVideoFrameCallback?.(videoFrameCallbackHandle);
    } catch {
      // Ignore cancellation errors during source swaps.
    }
    videoFrameCallbackHandle = null;
  };
  const scheduleVideoFrameProbe = () => {
    const video = videoRef as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }) | undefined;
    if (!video || !("requestVideoFrameCallback" in video)) return;
    clearVideoFrameCallback();
    try {
      videoFrameCallbackHandle = video.requestVideoFrameCallback?.(() => {
        videoFrameCallbackHandle = null;
        setVideoFrameReady(true);
        if (gpuStatus() === "ready") requestAnimationFrame(drawFrame);
      }) ?? null;
    } catch {
      videoFrameCallbackHandle = null;
    }
  };
  const requestVideoFrameDraw = () => {
    if (!videoRef) return;
    scheduleVideoFrameProbe();
    if (gpuStatus() === "ready") requestAnimationFrame(drawFrame);
  };
  const warmVideoFrame = () => {
    const video = videoRef;
    const clip = activeVideoClip();
    if (!video || !clip || transportPlaying() || video.readyState < 2) return;
    const token = ++videoWarmupToken;
    syncClipTime(clip, video);
    const settle = () => {
      if (token !== videoWarmupToken) return;
      video.pause();
      syncClipTime(activeVideoClip(), videoRef);
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
    syncClipTime(activeVideoClip(), videoRef);
    for (const clip of activeAudioClips()) {
      syncClipTime(clip, audioRefs.get(clip.id));
    }
    playMediaElement(videoRef);
    for (const clip of activeAudioClips()) {
      playMediaElement(audioRefs.get(clip.id));
    }
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
              struct Layout {
                scale: vec2f,
                pad: vec2f,
              };
              struct Out {
                @builtin(position) pos: vec4f,
                @location(0) uv: vec2f,
              };
              @group(0) @binding(0) var<uniform> layout: Layout;
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
                out.pos = vec4f(pos[i] * layout.scale, 0.0, 1.0);
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
    const video = videoRef;
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
      if (!videoFrameReady()) setVideoFrameReady(true);
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
    if (clip) syncClipTime(clip, videoRef);
    else videoRef?.pause();
    const activeAudioIds = new Set(activeAudioClips().map((item) => item.id));
    for (const audioClip of activeAudioClips()) {
      const element = audioRefs.get(audioClip.id);
      if (!element) continue;
      element.volume = Math.max(0, Math.min(1, audioClip.audio.gain));
      syncClipTime(audioClip, element);
    }
    for (const [clipId, element] of audioRefs.entries()) {
      if (!activeAudioIds.has(clipId)) element.pause();
    }
    if (transportPlaying()) {
      if (clip) playMediaElement(videoRef);
      for (const audioClip of activeAudioClips()) {
        playMediaElement(audioRefs.get(audioClip.id));
      }
    }
    if (gpuStatus() === "ready") drawFrame();
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
    if (!videoRef) return;
    videoWarmupToken += 1;
    clearVideoFrameCallback();
    setVideoFrameReady(false);
    if (!src || !key) {
      videoRef.pause();
      videoRef.removeAttribute("src");
      videoRef.load();
      return;
    }
    if (mediaElementHasSource(videoRef, src)) {
      syncClipTime(activeVideoClip(), videoRef);
      requestVideoFrameDraw();
      warmVideoFrame();
      return;
    }
    videoRef.pause();
    videoRef.removeAttribute("src");
    videoRef.load();
    videoRef.src = src;
    videoRef.load();
  });
  createEffect(() => {
    const activeIds = new Set(activeAudioClips().map((clip) => clip.id));
    for (const [clipId, element] of audioRefs.entries()) {
      if (activeIds.has(clipId)) continue;
      element.pause();
      audioRefs.delete(clipId);
    }
    for (const clip of activeAudioClips()) {
      const element = audioRefs.get(clip.id);
      const src = mediaSourceForClip(clip);
      if (!element || !src) continue;
      if (!mediaElementHasSource(element, src)) {
        element.src = src;
        element.load();
      }
      element.volume = Math.max(0, Math.min(1, clip.audio.gain));
      element.muted = !!clip.audio.muted;
    }
  });

  createEffect(
    on(seekRequest, (time) => {
      if (time === null) return;
      setPlayheadTime(time);
      if (transportPlaying()) syncTransportClock(time);
      syncClipTime(activeVideoClip(), videoRef);
      for (const clip of activeAudioClips()) {
        syncClipTime(clip, audioRefs.get(clip.id));
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
            ref={videoRef}
            controls
            preload="auto"
            muted
            playsinline
            class="monitor-fallback-video"
            style={{ display: activeVideoSource() ? "block" : "none" }}
            onLoadedMetadata={() => {
              syncClipTime(activeVideoClip(), videoRef);
              requestVideoFrameDraw();
              warmVideoFrame();
            }}
            onLoadedData={() => {
              syncClipTime(activeVideoClip(), videoRef);
              requestVideoFrameDraw();
              warmVideoFrame();
              if (transportPlaying()) playMediaElement(videoRef);
            }}
            onCanPlay={() => {
              syncClipTime(activeVideoClip(), videoRef);
              requestVideoFrameDraw();
              warmVideoFrame();
              if (transportPlaying()) playMediaElement(videoRef);
            }}
            onSeeked={() => {
              syncClipTime(activeVideoClip(), videoRef);
              requestVideoFrameDraw();
              warmVideoFrame();
              if (transportPlaying()) playMediaElement(videoRef);
            }}
          />
        </div>
        <div class="monitor-audio hidden" aria-hidden="true">
          <For each={activeAudioClips()}>
            {(clip) => (
              <audio
                ref={(element) => {
                  if (!element) return;
                  audioRefs.set(clip.id, element);
                }}
                preload="metadata"
                style={{ display: "none" }}
                onLoadedData={(event) => {
                  const element = event.currentTarget;
                  audioRefs.set(clip.id, element);
                  syncClipTime(clip, element);
                  if (transportPlaying()) playMediaElement(element);
                }}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
};

const TimelinePanel: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: ProjectUpdater) => void;
}> = (props) => {
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
    });
  };
  const scheduleVerticalUnlock = () => {
    if (verticalSyncHandle) cancelAnimationFrame(verticalSyncHandle);
    verticalSyncHandle = requestAnimationFrame(() => {
      syncingVertical = false;
    });
  };
  const syncHorizontalScroll = (source: HTMLDivElement) => {
    syncViewportMetrics(source);
    if (syncingHorizontal) return;
    syncingHorizontal = true;
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
    if (syncingVertical) return;

    syncingVertical = true;
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
    <button
      type="button"
      class={`tl-label tl-label--dynamic${selectedTrackId() === track.id ? " active" : ""}`}
      style={{ height: `${trackHeight(track.kind)}px` }}
      onClick={() => {
        setSelectedTrackId(track.id);
        setSelectedClipId(null);
        setSelectedSubtitleId(null);
      }}
    >
      {track.name}
    </button>
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
          <span>{dragPreview()!.label}</span>
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
              <span>{assetById(project()!, clip.asset_id)?.label || "Clip"}</span>
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
        didInitMirroredVertical = false;
        requestAnimationFrame(initializeMirroredVerticalScroll);
      },
    ),
  );
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
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            title="Frame precedente (Freccia sinistra)"
            onClick={() => setFrameStepRequest(-1)}
          >
            ←
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            title="Play/Pause (Space)"
            onClick={() => setPlayPauseRequest((value) => value + 1)}
          >
            Space
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            title="Frame successivo (Freccia destra)"
            onClick={() => setFrameStepRequest(1)}
          >
            →
          </button>
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
          <span class="timeline-selection-readout">
            {selectedClip()
              ? `Clip ${assetById(project()!, selectedClip()!.asset_id)?.label || ""}`
              : selectedSubtitle()
                ? "Subtitle block"
                : selectedTrackId()
                  ? `Lane ${getTrack(project()!, selectedTrackId())?.name || ""}`
                  : "Nessuna selezione"}
          </span>
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
              <For each={assetTracks()}>{renderTrackLabel}</For>
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
              <For each={audioTracks()}>{renderTrackLabel}</For>
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
