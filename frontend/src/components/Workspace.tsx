import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Component } from "solid-js";
import { useJobQuery, useArtifactQuery, useJobPolling, useUpdateTranscriptMutation } from "../api/queries";
import { fileUrl } from "../api/client";
import {
  selectedJobId,
  selectedStep,
  updateTabLabel,
  getPreviewForJob,
  getMonitorForJob,
  setPreviewForJob,
  setMonitorForJob,
  playheadTime,
  setPlayheadTime,
  seekRequest,
  setSeekRequest,
  playPauseRequest,
  setPlayPauseRequest,
  autoFollow,
  setAutoFollow,
  frameStepRequest,
  setFrameStepRequest,
} from "../store";
import {
  baseName,
  buildArtifactCatalog,
  capitalize,
  fmtTime,
  fmtTimePrecise,
  getMonitorSources,
  humanizeMediaName,
  inferFileType,
  isPreviewableText,
} from "../lib/utils";
import type { JobSnapshot } from "../types";
import PipelineBar from "./PipelineBar";
import ParamsInspector from "./ParamsInspector";

const TIMELINE_SPLITTER_HEIGHT = 4;
const PANEL_SPLITTER_WIDTH = 4;
const MIN_TIMELINE_HEIGHT = 180;
const MIN_TOP_WORKSPACE_HEIGHT = 220;
const MIN_BROWSER_WIDTH = 220;
const MAX_BROWSER_WIDTH = 440;

const Workspace: Component = () => {
  const job = useJobQuery(selectedJobId);
  const hasJob = () => !!job.data;
  const [timelineHeight, setTimelineHeight] = createSignal<number | null>(null);
  const [browserWidth, setBrowserWidth] = createSignal(280);
  let editorMainRef: HTMLDivElement | undefined;

  // Sync tab label with job title
  createEffect(
    on(
      () => (job.data as JobSnapshot | undefined)?.title,
      (title) => {
        const id = selectedJobId();
        if (id && title) updateTabLabel(id, title);
      },
    ),
  );

  // Poll only while a backend worker is actually running.
  const polling = useJobPolling(selectedJobId);

  createEffect(
    on(
      () => (job.data as JobSnapshot | undefined)?.status,
      (status) => {
        if (status === "running") {
          polling.start();
        } else {
          polling.stop();
        }
      },
    ),
  );

  // Also restart polling when selected job changes
  createEffect(
    on(selectedJobId, () => {
      const status = (job.data as JobSnapshot | undefined)?.status;
      if (status === "running") {
        polling.start();
      } else {
        polling.stop();
      }
    }),
  );

  onCleanup(() => polling.stop());

  const clampBrowserWidth = (width: number) =>
    Math.max(MIN_BROWSER_WIDTH, Math.min(MAX_BROWSER_WIDTH, Math.round(width)));

  const clampTimelineHeight = (height: number) => {
    if (!editorMainRef) return Math.max(MIN_TIMELINE_HEIGHT, Math.round(height));
    const totalHeight = editorMainRef.getBoundingClientRect().height - TIMELINE_SPLITTER_HEIGHT;
    const maxHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight - MIN_TOP_WORKSPACE_HEIGHT);
    return Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxHeight, Math.round(height)));
  };

  const editorShellColumns = () => `${browserWidth()}px ${PANEL_SPLITTER_WIDTH}px minmax(0, 1fr)`;

  const editorMainRows = () =>
    timelineHeight() === null
      ? `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px minmax(0, 1fr)`
      : `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px ${timelineHeight()}px`;

  const onBrowserResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = browserWidth();

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      setBrowserWidth(clampBrowserWidth(startWidth + delta));
    };
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

    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      setTimelineHeight(clampTimelineHeight(startHeight + delta));
    };
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
      <Show when={hasJob()} fallback={<div class="empty-state"><div class="empty-content"><p>Caricamento progetto...</p></div></div>}>
        <div class="project-workspace">
          <div
            class="editor-shell"
            style={{ "grid-template-columns": editorShellColumns() }}
          >
            <div class="browser-col">
              <ArtifactBrowserPanel />
            </div>
            <div class="browser-resize-handle" onPointerDown={onBrowserResizeStart} />
            <div class="editor-main-wrap">
              <PipelineBar />
              <div
                ref={editorMainRef}
                class="editor-main"
                style={{ "grid-template-rows": editorMainRows() }}
              >
                <WorkspaceGrid />
                <div class="workspace-vsplit" onPointerDown={onTimelineResizeStart} />
                <TimelinePanel />
              </div>
            </div>
          </div>
        </div>
      </Show>
    </main>
  );
};

/* ---- Helpers ---- */

function useJob() {
  return useJobQuery(selectedJobId);
}

/* ---- Monitor ---- */

/* Step display order & labels */
const STEP_ORDER = ["ingest", "transcription", "editorial", "render", "output"] as const;
const STEP_LABELS: Record<string, string> = {
  ingest: "Ingest",
  transcription: "Transcription",
  editorial: "Editorial",
  render: "Render",
  output: "Output",
};
const STEP_ICONS: Record<string, string> = {
  ingest: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
  transcription: "M12 3a9 9 0 110 18 9 9 0 010-18zm-1 5v5l4 2.5",
  editorial: "M4 6h16M4 12h10M4 18h14",
  render: "M5 3l14 9-14 9V3z",
  output: "M12 2l8 4v8l-8 4-8-4V6l8-4z",
};

interface ArtifactGroup {
  step: string;
  label: string;
  items: import("../types").ArtifactEntry[];
}

const FileTypeIcon: Component<{ type: string }> = (props) => {
  const iconPaths: Record<string, string> = {
    video: "M15 10l5-3v10l-5-3zM4 6h11a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z",
    audio: "M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z",
    json: "M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16",
    text: "M4 6h16M4 10h16M4 14h10M4 18h12",
    binary: "M10 4H4v6h6V4zm10 0h-6v6h6V4zm-10 10H4v6h6v-6zm10 0h-6v6h6v-6z",
  };
  return (
    <svg class={`asset-type-icon asset-type-icon--${props.type}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d={iconPaths[props.type] || iconPaths.binary} />
    </svg>
  );
};

const ASSET_PREVIEW_MIN = 120;
const ASSET_LIST_MIN = 140;

type SidebarTab = "assets" | "logs";

const ArtifactBrowserPanel: Component = () => {
  const job = useJob();
  const data = () => job.data as JobSnapshot | undefined;
  const [filter, setFilter] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const [previewHeight, setPreviewHeight] = createSignal(220);
  const [activeTab, setActiveTab] = createSignal<SidebarTab>("assets");
  let containerRef: HTMLDivElement | undefined;

  /* Logs data */
  const logs = createMemo(() => (data())?.logs ?? []);
  const error = () => data()?.error;

  const catalog = createMemo(() => {
    const j = data();
    return j ? buildArtifactCatalog(j) : [];
  });

  const groups = createMemo<ArtifactGroup[]>(() => {
    const items = catalog();
    const f = filter().toLowerCase();
    const byStep = new Map<string, import("../types").ArtifactEntry[]>();
    for (const item of items) {
      if (f && !baseName(item.path).toLowerCase().includes(f) && !item.step.toLowerCase().includes(f)) continue;
      const arr = byStep.get(item.step) ?? [];
      arr.push(item);
      byStep.set(item.step, arr);
    }
    return STEP_ORDER
      .filter((s) => byStep.has(s))
      .map((s) => ({ step: s, label: STEP_LABELS[s] || capitalize(s), items: byStep.get(s)! }));
  });

  const totalCount = () => groups().reduce((n, g) => n + g.items.length, 0);

  const jobId = () => data()?.id;
  const currentPreview = () => {
    const id = jobId();
    return id ? getPreviewForJob(id) : undefined;
  };
  const itemTitle = (path: string) => {
    const type = inferFileType(path);
    return type === "video" || type === "audio" ? humanizeMediaName(path) : baseName(path);
  };

  const isActive = (path: string) => currentPreview() === path;

  const openArtifact = (path: string) => {
    const id = jobId();
    if (!id) return;
    setPreviewForJob(id, path);
  };

  const toggleGroup = (step: string) => {
    setCollapsed((prev) => ({ ...prev, [step]: !prev[step] }));
  };

  /* ---- Preview pane data ---- */
  const previewPath = createMemo(() => {
    const id = jobId();
    if (!id) return null;
    const j = data();
    if (!j) return null;
    const cat = buildArtifactCatalog(j);
    const p = getPreviewForJob(id);
    if (p && cat.some((item) => item.path === p)) return p;
    const preferred = [
      "06_edit_decision_list.json",
      "05_spans_labeled.json",
      "07_caption_display.json",
      "04_transcript_aligned.json",
      "03_transcript_raw.json",
      "01_media_probe.json",
    ];
    for (const suffix of preferred) {
      const match = cat.find((i) => i.path.endsWith(suffix));
      if (match) return match.path;
    }
    return null;
  });

  const shouldFetch = createMemo(() => {
    const p = previewPath();
    return p && isPreviewableText(p) ? p : null;
  });

  const artifact = useArtifactQuery(() => jobId() ?? null, shouldFetch);

  const previewSrc = createMemo(() => {
    const id = jobId();
    const p = previewPath();
    return id && p ? fileUrl(id, p) : null;
  });

  const previewName = createMemo(() => {
    const p = previewPath();
    return p ? baseName(p) : "";
  });

  const previewFileType = createMemo(() => {
    const p = previewPath();
    return p ? inferFileType(p) : null;
  });

  const content = createMemo(() => {
    const entry = artifact.data;
    if (!entry) return null;
    return entry.type === "json" ? JSON.stringify(entry.data, null, 2) : entry.text;
  });

  /* ---- Vertical splitter between list and preview ---- */
  const onPreviewResizeStart = (e: PointerEvent) => {
    if (!containerRef) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = previewHeight();
    const totalH = containerRef.getBoundingClientRect().height;

    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      const newH = Math.max(ASSET_PREVIEW_MIN, Math.min(totalH - ASSET_LIST_MIN, startH + delta));
      setPreviewHeight(newH);
    };
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

  return (
    <div class="panel asset-explorer" ref={containerRef}>
      {/* Tab bar */}
      <div class="sidebar-tabs">
        <button
          type="button"
          class={`sidebar-tab${activeTab() === "assets" ? " active" : ""}`}
          onClick={() => setActiveTab("assets")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
          </svg>
          Assets
          <span class="sidebar-tab-badge">{totalCount()}</span>
        </button>
        <button
          type="button"
          class={`sidebar-tab${activeTab() === "logs" ? " active" : ""}`}
          onClick={() => setActiveTab("logs")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16M4 10h16M4 14h10M4 18h12" />
          </svg>
          Log
          <Show when={logs().length > 0}>
            <span class="sidebar-tab-badge">{logs().length}</span>
          </Show>
        </button>
      </div>

      {/* ===== ASSETS TAB ===== */}
      <div class="sidebar-tab-body" style={{ display: activeTab() === "assets" ? "flex" : "none" }}>
        {/* Search */}
        <div class="asset-explorer-search">
          <svg class="asset-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            class="asset-search-input"
            placeholder="Filtra artefatti..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <Show when={filter().length > 0}>
            <button type="button" class="asset-search-clear" onClick={() => setFilter("")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </Show>
        </div>

        {/* Asset list */}
        <div class="asset-explorer-content">
          <Show when={totalCount() === 0}>
            <div class="asset-explorer-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
              <span>{filter() ? "Nessun risultato" : "Nessun artefatto disponibile"}</span>
            </div>
          </Show>
          <For each={groups()}>
            {(group) => (
              <div class="asset-group">
                <button type="button" class="asset-group-header" onClick={() => toggleGroup(group.step)}>
                  <svg class={`asset-group-chevron${collapsed()[group.step] ? " collapsed" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <svg class="asset-group-step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d={STEP_ICONS[group.step] || STEP_ICONS.output} />
                  </svg>
                  <span class="asset-group-label">{group.label}</span>
                  <span class="asset-group-count">{group.items.length}</span>
                </button>
                <Show when={!collapsed()[group.step]}>
                  <div class="asset-group-items">
                    <For each={group.items}>
                      {(item) => {
                        const ftype = () => inferFileType(item.path);
                        return (
                          <button
                            type="button"
                            class={`asset-item${isActive(item.path) ? " active" : ""}`}
                            onClick={() => openArtifact(item.path)}
                            title={item.path}
                          >
                            <FileTypeIcon type={ftype()} />
                            <span class="asset-item-name">{itemTitle(item.path)}</span>
                            <span class={`asset-item-badge asset-item-badge--${ftype()}`}>{ftype().toUpperCase()}</span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* Splitter */}
        <div class="asset-preview-splitter" onPointerDown={onPreviewResizeStart} />

        {/* Inline preview pane */}
        <div class="asset-preview-pane" style={{ height: `${previewHeight()}px` }}>
          <div class="asset-preview-header">
            <svg class="asset-preview-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span class="asset-preview-title">
              {previewName() || "Preview"}
            </span>
            <Show when={previewSrc()}>
              <a class="asset-preview-open" href={previewSrc()!} target="_blank">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </Show>
          </div>
          <div class="asset-preview-body">
            <Show when={!previewPath()}>
              <div class="asset-preview-empty">Seleziona un artefatto</div>
            </Show>
            <Show when={previewPath()}>
              {(() => {
                const ft = previewFileType();
                if (ft === "video") {
                  return <video class="asset-preview-media" src={previewSrc()!} controls preload="metadata" />;
                }
                if (ft === "audio") {
                  return <audio class="asset-preview-media asset-preview-audio" src={previewSrc()!} controls preload="metadata" />;
                }
                return (
                  <Show when={content() !== null} fallback={
                    <div class="asset-preview-empty">
                      {artifact.isLoading ? "Caricamento..." : "Preview non disponibile"}
                    </div>
                  }>
                    <pre class="asset-preview-code">{content()}</pre>
                  </Show>
                );
              })()}
            </Show>
          </div>
        </div>
      </div>

      {/* ===== LOGS TAB ===== */}
      <div class="sidebar-tab-body sidebar-tab-body--logs" style={{ display: activeTab() === "logs" ? "flex" : "none" }}>
        <div class="sidebar-logs-content">
          <Show when={logs().length === 0 && !error()}>
            <div class="asset-explorer-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6h16M4 10h16M4 14h10M4 18h12" />
              </svg>
              <span>Nessun log disponibile</span>
            </div>
          </Show>
          <Show when={error()}>
            <div class="sidebar-log-line sidebar-log-error">{error()}</div>
          </Show>
          <For each={[...logs()].reverse()}>
            {(line) => <div class="sidebar-log-line">{line}</div>}
          </For>
        </div>
      </div>
    </div>
  );
};

/* ---- Resizable workspace grid ---- */

const WorkspaceGrid: Component = () => {
  const [inspectorWidth, setInspectorWidth] = createSignal(340);
  let gridRef: HTMLDivElement | undefined;

  const onResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorWidth();

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      setInspectorWidth(Math.max(240, Math.min(600, startW + delta)));
    };
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
    <div
      ref={gridRef}
      class="workspace-grid"
      style={{ "grid-template-columns": `1fr 4px ${inspectorWidth()}px` }}
    >
      <div class="monitor-col">
        <MonitorPanel />
      </div>
      <div class="resize-handle" onPointerDown={onResizeStart} />
      <div class="inspector-col">
        <ParamsInspector />
      </div>
    </div>
  );
};

/* ---- Monitor ---- */

/**
 * The video/audio element is kept alive via refs and imperative src updates.
 * We never use ternaries or <Show> around media elements — this prevents
 * Solid from destroying/recreating them on reactive updates.
 */
const MonitorPanel: Component = () => {
  const job = useJob();
  const data = () => job.data as JobSnapshot | undefined;

  const sources = createMemo(() => {
    const j = data();
    return j ? getMonitorSources(j) : [];
  });

  const jobId = () => data()?.id;

  const activePath = createMemo(() => {
    const id = jobId();
    if (!id) return null;
    const s = sources();
    const c = getMonitorForJob(id);
    if (c && s.some((source) => source.path === c)) return c;
    if (s.length) {
      setMonitorForJob(id, s[0].path);
      return s[0].path;
    }
    return null;
  });

  const mediaSrc = createMemo(() => {
    const id = jobId();
    const p = activePath();
    if (!id || !p) return null;
    // Cache buster: append updated_at so browser reloads after re-render
    const ts = data()?.updated_at ?? "";
    return `${fileUrl(id, p)}?t=${encodeURIComponent(ts)}`;
  });

  const mediaType = createMemo(() => {
    const p = activePath();
    return p ? inferFileType(p) : null;
  });

  // Imperative: keep refs, update src without remounting
  let videoRef: HTMLVideoElement | undefined;
  let audioRef: HTMLAudioElement | undefined;

  const getActiveEl = () => (mediaType() === "video" ? videoRef : audioRef) ?? null;

  // Smooth playhead via requestAnimationFrame
  let rafHandle = 0;
  const tick = () => {
    const el = getActiveEl();
    if (el && !el.paused && Number.isFinite(el.currentTime)) {
      setPlayheadTime(el.currentTime);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
  onCleanup(() => cancelAnimationFrame(rafHandle));

  createEffect(
    on(mediaSrc, (src) => {
      if (videoRef && src && mediaType() === "video") {
        if (videoRef.getAttribute("src") !== src) {
          videoRef.src = src;
          videoRef.load();
        }
      }
      if (audioRef && src && mediaType() === "audio") {
        if (audioRef.getAttribute("src") !== src) {
          audioRef.src = src;
          audioRef.load();
        }
      }
    }),
  );

  // Respond to seek requests from the timeline
  createEffect(
    on(seekRequest, (t) => {
      if (t === null) return;
      const el = getActiveEl();
      if (el && Number.isFinite(t)) {
        el.currentTime = t;
        setPlayheadTime(t);
      }
      setSeekRequest(null);
    }),
  );

  // Respond to play/pause toggle (spacebar)
  createEffect(
    on(playPauseRequest, () => {
      const el = getActiveEl();
      if (!el) return;
      if (el.paused) el.play();
      else el.pause();
    }, { defer: true }),
  );

  // Frame step: pause video, advance by 1/fps
  createEffect(
    on(frameStepRequest, (dir) => {
      if (dir === 0) return;
      const el = getActiveEl();
      if (!el) return;
      // Pause first so we can scrub frame by frame
      if (!el.paused) el.pause();
      // Use the video's fps from probe, fallback to 30
      const fps = (videoRef as any)?._fellini_fps || 30;
      const frameDur = 1 / fps;
      const newTime = Math.max(0, el.currentTime + dir * frameDur);
      el.currentTime = newTime;
      setPlayheadTime(newTime);
      setFrameStepRequest(0);
    }),
  );

  // Store fps from probe on the video element
  createEffect(
    on(
      () => data()?.id,
      () => {
        const j = data();
        if (!j || !videoRef) return;
        const probeArt = buildArtifactCatalog(j).find((a) => a.path.endsWith("01_media_probe.json"));
        if (!probeArt) return;
        fetch(fileUrl(j.id, probeArt.path))
          .then((r) => r.json())
          .then((p: { sources?: { fps?: number }[] }) => {
            const fps = p?.sources?.[0]?.fps;
            if (fps && videoRef) (videoRef as any)._fellini_fps = fps;
          })
          .catch(() => {});
      },
    ),
  );

  // Global keyboard handler: Space=play/pause, Left/Right=frame step, J/L=5s skip
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        setPlayPauseRequest((n) => n + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Left: skip back 5s
          setSeekRequest(Math.max(0, playheadTime() - 5));
        } else {
          setFrameStepRequest(-1);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Right: skip forward 5s
          setSeekRequest(playheadTime() + 5);
        } else {
          setFrameStepRequest(1);
        }
        break;
      case "KeyJ":
        e.preventDefault();
        setSeekRequest(Math.max(0, playheadTime() - 5));
        break;
      case "KeyL":
        e.preventDefault();
        setSeekRequest(playheadTime() + 5);
        break;
      case "KeyK":
        e.preventDefault();
        setPlayPauseRequest((n) => n + 1);
        break;
    }
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <div class="panel monitor-panel">
      <div class="panel-header">
        <span class="panel-title">Monitor</span>
        <div class="monitor-switches">
          <For each={sources()}>
            {(s) => (
              <button
                type="button"
                class={`monitor-btn${activePath() === s.path ? " active" : ""}`}
                onClick={() => {
                  const id = jobId();
                  if (id) setMonitorForJob(id, s.path);
                }}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="monitor-stage">
        <video
          ref={videoRef}
          controls
          preload="metadata"
          style={{
            display: mediaSrc() && mediaType() === "video" ? "block" : "none",
          }}
        />
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          style={{
            display: mediaSrc() && mediaType() === "audio" ? "block" : "none",
            padding: "12px",
          }}
        />
        <div
          class="placeholder"
          style={{
            display: !mediaSrc() ? "block" : "none",
          }}
        >
          Nessun media disponibile
        </div>
      </div>
    </div>
  );
};

/* ---- Timeline ---- */

interface AlignmentWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

interface AlignmentSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: AlignmentWord[];
}

interface AlignmentTranscript {
  language: string;
  segments: AlignmentSegment[];
  source: string;
  notes: string[];
}

type OverviewSegmentTone = "keep" | "group" | "cut" | "maybe" | "shorten";

interface OverviewSegment {
  start: number;
  end: number;
  tone: OverviewSegmentTone;
}

const ZOOM_STEPS = [0.5, 1, 2, 4, 8, 16];
const MIN_PX_PER_SEC = 60; // at zoom 1x
const MIN_ALIGNMENT_WORD_DURATION = 0.02;

const TimelinePanel: Component = () => {
  const job = useJob();
  const data = () => job.data as JobSnapshot | undefined;
  const [zoomIdx, setZoomIdx] = createSignal(1); // index into ZOOM_STEPS, start at 1x
  const zoom = () => ZOOM_STEPS[zoomIdx()];
  const alignmentMode = createMemo(() => selectedStep() === "transcription");
  const updateAlignmentMut = useUpdateTranscriptMutation();
  const [localAlignment, setLocalAlignment] = createSignal<AlignmentTranscript | null>(null);
  const [alignmentDirty, setAlignmentDirty] = createSignal(false);
  const [activeAlignmentWord, setActiveAlignmentWord] = createSignal<{ seg: number; word: number } | null>(null);
  let alignmentDragCleanup: (() => void) | undefined;

  // Artifact paths
  const artifactPath = (suffix: string) =>
    createMemo(() => {
      const j = data();
      return j ? (buildArtifactCatalog(j).find((i) => i.path.endsWith(suffix))?.path ?? null) : null;
    });

  const edlPath = artifactPath("06_edit_decision_list.json");
  const probePath = artifactPath("01_media_probe.json");
  const spansPath = artifactPath("05_spans_labeled.json");
  const captionsPath = artifactPath("07_caption_display.json");
  const rawTranscriptPath = artifactPath("03_transcript_raw.json");
  const alignedTranscriptPath = artifactPath("04_transcript_aligned.json");

  const jobIdAccessor = () => data()?.id ?? null;
  const edl = useArtifactQuery(jobIdAccessor, edlPath);
  const probe = useArtifactQuery(jobIdAccessor, probePath);
  const spansQ = useArtifactQuery(jobIdAccessor, spansPath);
  const captionsQ = useArtifactQuery(jobIdAccessor, captionsPath);
  const rawTranscriptQ = useArtifactQuery(jobIdAccessor, rawTranscriptPath);
  const alignedTranscriptQ = useArtifactQuery(jobIdAccessor, alignedTranscriptPath);

  // Derived data
  const duration = createMemo(() => {
    const d = probe.data?.data as { sources?: { duration_seconds: number }[] } | undefined;
    return d?.sources?.reduce((s, i) => s + (i.duration_seconds || 0), 0) ?? 0;
  });

  const ranges = createMemo(() => {
    const d = edl.data?.data as { keep_ranges?: { start: number; end: number; reason: string }[] } | undefined;
    return d?.keep_ranges ?? [];
  });

  const cuts = createMemo(() => {
    const d = edl.data?.data as { soft_cuts?: { at: number }[] } | undefined;
    return d?.soft_cuts ?? [];
  });

  const spans = createMemo(() => {
    const d = spansQ.data?.data as { spans?: { text: string; start: number; end: number; label: string }[] } | undefined;
    return d?.spans ?? [];
  });

  const captions = createMemo(() => {
    const d = captionsQ.data?.data as { chunks?: { start: number; end: number; display_words: string[] }[] } | undefined;
    return d?.chunks ?? [];
  });

  const transcript = createMemo((): AlignmentTranscript | null => {
    const aligned = alignedTranscriptQ.data?.data as AlignmentTranscript | undefined;
    const raw = rawTranscriptQ.data?.data as AlignmentTranscript | undefined;
    if (aligned?.segments?.length) return aligned;
    if (raw?.segments?.length) return raw;
    return null;
  });

  createEffect(
    on(transcript, (value) => {
      if (!alignmentDirty()) {
        setLocalAlignment(value ? JSON.parse(JSON.stringify(value)) : null);
      }
    }),
  );

  const stopAlignmentDrag = () => {
    alignmentDragCleanup?.();
    alignmentDragCleanup = undefined;
  };

  onCleanup(stopAlignmentDrag);

  createEffect(
    on(jobIdAccessor, () => {
      stopAlignmentDrag();
      setAlignmentDirty(false);
      setActiveAlignmentWord(null);
    }),
  );

  createEffect(
    on(alignmentMode, (active) => {
      if (!active) {
        stopAlignmentDrag();
        setActiveAlignmentWord(null);
      }
    }),
  );

  const alignmentSegments = createMemo(() => localAlignment()?.segments ?? []);
  const canEditAlignment = () => alignmentMode() && data()?.status !== "running";
  const hasEditorialData = createMemo(() => duration() > 0 && (ranges().length > 0 || spans().length > 0));
  const hasAlignmentData = createMemo(() => duration() > 0 && alignmentSegments().length > 0);
  const hasData = createMemo(() => (alignmentMode() ? hasAlignmentData() : hasEditorialData()));

  const syncAlignmentSegment = (copy: AlignmentTranscript, segIdx: number) => {
    const segment = copy.segments[segIdx];
    segment.text = segment.words.map((word) => word.text).join(" ");
    if (segment.words.length > 0) {
      segment.start = segment.words[0].start;
      segment.end = segment.words[segment.words.length - 1].end;
    }
  };

  const previousWordEnd = (copy: AlignmentTranscript, segIdx: number, wordIdx: number) => {
    if (wordIdx > 0) return copy.segments[segIdx].words[wordIdx - 1].end;
    for (let prevSeg = segIdx - 1; prevSeg >= 0; prevSeg -= 1) {
      const words = copy.segments[prevSeg].words;
      if (words.length > 0) return words[words.length - 1].end;
    }
    return 0;
  };

  const nextWordStart = (copy: AlignmentTranscript, segIdx: number, wordIdx: number) => {
    const words = copy.segments[segIdx].words;
    if (wordIdx < words.length - 1) return words[wordIdx + 1].start;
    for (let nextSeg = segIdx + 1; nextSeg < copy.segments.length; nextSeg += 1) {
      const nextWords = copy.segments[nextSeg].words;
      if (nextWords.length > 0) return nextWords[0].start;
    }
    return duration() > 0 ? duration() : Number.POSITIVE_INFINITY;
  };

  const updateAlignmentWordEdge = (
    segIdx: number,
    wordIdx: number,
    edge: "start" | "end",
    nextTime: number,
  ) => {
    setLocalAlignment((prev) => {
      if (!prev) return prev;
      const copy: AlignmentTranscript = JSON.parse(JSON.stringify(prev));
      const word = copy.segments[segIdx]?.words[wordIdx];
      if (!word) return prev;

      if (edge === "start") {
        const minStart = previousWordEnd(copy, segIdx, wordIdx);
        const maxStart = word.end - MIN_ALIGNMENT_WORD_DURATION;
        word.start = Math.max(minStart, Math.min(maxStart, nextTime));
      } else {
        const minEnd = word.start + MIN_ALIGNMENT_WORD_DURATION;
        const maxEnd = nextWordStart(copy, segIdx, wordIdx);
        word.end = Math.max(minEnd, Math.min(maxEnd, nextTime));
      }

      syncAlignmentSegment(copy, segIdx);
      return copy;
    });
    setAlignmentDirty(true);
  };

  const activeAlignmentWordData = createMemo(() => {
    const active = activeAlignmentWord();
    if (!active) return null;
    const segment = alignmentSegments()[active.seg];
    const word = segment?.words?.[active.word];
    if (!segment || !word) return null;
    return { segment, word };
  });

  const overviewSegments = createMemo<OverviewSegment[]>(() => {
    if (alignmentMode()) {
      return alignmentSegments().map((segment) => ({
        start: segment.start,
        end: segment.end,
        tone: "group",
      }));
    }

    if (ranges().length > 0) {
      return ranges().map((range) => ({
        start: range.start,
        end: range.end,
        tone: "keep",
      }));
    }

    return spans().map((span) => ({
      start: span.start,
      end: span.end,
      tone:
        span.label === "CUT"
          ? "cut"
          : span.label === "MAYBE"
            ? "maybe"
            : span.label === "SHORTEN"
              ? "shorten"
              : "keep",
    }));
  });

  const overviewCuts = createMemo(() => (alignmentMode() ? [] : cuts()));
  const showOverview = createMemo(() => hasData() && duration() > 0);

  // Pixel math
  const totalWidth = () => Math.max(duration() * MIN_PX_PER_SEC * zoom(), 400);
  const toPx = (sec: number) => (sec / duration()) * totalWidth();

  // Ruler ticks
  const rulerTicks = createMemo(() => {
    const d = duration();
    if (d <= 0) return [];
    const z = zoom();
    // Decide tick interval based on zoom: more zoom = finer ticks
    let interval = 1;
    if (z <= 1) interval = Math.max(1, Math.ceil(d / 20));
    else if (z <= 4) interval = 0.5;
    else interval = 0.25;

    const ticks: { sec: number; major: boolean }[] = [];
    for (let t = 0; t <= d; t += interval) {
      const major = Number.isInteger(t) || t % 1 < 0.001;
      ticks.push({ sec: t, major });
    }
    return ticks;
  });

  // Zoom controls
  const zoomIn = () => setZoomIdx((i) => Math.min(i + 1, ZOOM_STEPS.length - 1));
  const zoomOut = () => setZoomIdx((i) => Math.max(i - 1, 0));

  // Wheel zoom on viewport — accumulate pinch delta to reduce sensitivity
  let viewportRef: HTMLDivElement | undefined;
  let innerRef: HTMLDivElement | undefined;
  let zoomAccum = 0;
  const ZOOM_THRESHOLD = 50; // accumulated pixels before changing zoom step
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAccum += e.deltaY;
      if (Math.abs(zoomAccum) >= ZOOM_THRESHOLD) {
        if (zoomAccum < 0) zoomIn();
        else zoomOut();
        zoomAccum = 0;
      }
    }
  };

  // Playhead: px position derived from playheadTime signal
  const playheadPx = () => toPx(playheadTime());

  // Click anywhere on the timeline to seek
  const pxToSec = (px: number) => {
    const tw = totalWidth();
    if (tw <= 0) return 0;
    return Math.max(0, Math.min(duration(), (px / tw) * duration()));
  };

  const getTimeFromMouseEvent = (e: MouseEvent): number => {
    if (!innerRef) return 0;
    const rect = innerRef.getBoundingClientRect();
    return pxToSec(e.clientX - rect.left);
  };

  const onPointerDown = (e: PointerEvent) => {
    // Only left button
    if (e.button !== 0) return;
    e.preventDefault();
    const t = getTimeFromMouseEvent(e);
    setSeekRequest(t);

    // Start drag
    const onMove = (ev: PointerEvent) => {
      const t2 = getTimeFromMouseEvent(ev);
      setSeekRequest(t2);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // Auto-follow: scroll viewport to keep playhead visible
  createEffect(() => {
    if (!autoFollow() || !viewportRef) return;
    const px = playheadPx();
    const vw = viewportRef.clientWidth;
    const scrollLeft = viewportRef.scrollLeft;
    // If playhead is outside the visible area, scroll to center it
    if (px < scrollLeft + 40 || px > scrollLeft + vw - 40) {
      viewportRef.scrollLeft = Math.max(0, px - vw / 3);
    }
  });

  // Track scroll position for minimap viewport indicator
  const [scrollFrac, setScrollFrac] = createSignal(0);
  const [viewFrac, setViewFrac] = createSignal(1);
  const updateScrollFracs = () => {
    if (!viewportRef) return;
    const tw = totalWidth();
    if (tw <= 0) return;
    setScrollFrac(viewportRef.scrollLeft / tw);
    setViewFrac(Math.min(1, viewportRef.clientWidth / tw));
  };

  createEffect(() => {
    showOverview();
    totalWidth();
    queueMicrotask(() => updateScrollFracs());
  });

  // Tooltip state
  const [tooltip, setTooltip] = createSignal<{ text: string; x: number; y: number } | null>(null);

  const onSegmentEnter = (e: MouseEvent, text: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top });
  };
  const onSegmentLeave = () => setTooltip(null);

  const edgeHitZone = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.min(10, Math.max(4, rect.width * 0.25));
  };

  const edgeFromPointer = (el: HTMLElement, clientX: number): "start" | "end" | null => {
    const rect = el.getBoundingClientRect();
    const zone = edgeHitZone(el);
    if (clientX - rect.left <= zone) return "start";
    if (rect.right - clientX <= zone) return "end";
    return null;
  };

  const beginAlignmentResize = (
    event: PointerEvent,
    segIdx: number,
    wordIdx: number,
    edge: "start" | "end",
  ) => {
    if (!innerRef || !canEditAlignment()) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveAlignmentWord({ seg: segIdx, word: wordIdx });

    const applyClientX = (clientX: number) => {
      const rect = innerRef!.getBoundingClientRect();
      const nextTime = pxToSec(clientX - rect.left);
      updateAlignmentWordEdge(segIdx, wordIdx, edge, nextTime);
      setSeekRequest(nextTime);
    };

    stopAlignmentDrag();
    applyClientX(event.clientX);

    const onMove = (moveEvent: PointerEvent) => applyClientX(moveEvent.clientX);
    const onUp = () => stopAlignmentDrag();

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    alignmentDragCleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  };

  const saveAlignment = async () => {
    const snapshot = localAlignment();
    const jobId = jobIdAccessor();
    if (!snapshot || !jobId) return;
    await updateAlignmentMut.mutateAsync({
      jobId,
      transcript: snapshot,
      target: "transcription",
    });
    setAlignmentDirty(false);
  };

  const showWords = () => spans().length > 0;
  const showCaptions = () => captions().length > 0;
  const showCuts = () => cuts().length > 0;
  const placeholderText = createMemo(() => {
    if (alignmentMode()) {
      if (duration() <= 0) return "La timeline della transcription apparira dopo ingest.";
      return "Esegui transcription per modificare parole e timing.";
    }
    return "La timeline apparira dopo lo step editorial";
  });

  return (
    <div class="panel timeline-panel">
      <div class="panel-header">
        <span class="panel-title">Timeline</span>
        <div class="timeline-toolbar">
          <span class="timeline-zoom-label" style={{ "min-width": "60px" }}>{fmtTimePrecise(playheadTime())}</span>
          <Show when={alignmentMode()}>
            <span class="timeline-mode-tag">Transcription</span>
          </Show>
          <Show when={alignmentMode() && activeAlignmentWordData()}>
            {(active) => (
              <span class="timeline-selection-readout">
                {active().word.text} {fmtTimePrecise(active().word.start)} - {fmtTimePrecise(active().word.end)}
              </span>
            )}
          </Show>
          <button
            type="button"
            class={`btn btn-xs ${autoFollow() ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setAutoFollow(!autoFollow())}
            title="Auto-follow playhead"
          >
            Follow
          </button>
          <button type="button" class="btn btn-ghost btn-xs" onClick={zoomOut} disabled={zoomIdx() === 0}>-</button>
          <span class="timeline-zoom-label">{zoom()}x</span>
          <button type="button" class="btn btn-ghost btn-xs" onClick={zoomIn} disabled={zoomIdx() === ZOOM_STEPS.length - 1}>+</button>
          <Show when={alignmentMode() && alignmentDirty()}>
            <button
              type="button"
              class="btn btn-primary btn-xs"
              disabled={updateAlignmentMut.isPending || !canEditAlignment()}
              onClick={saveAlignment}
            >
              {updateAlignmentMut.isPending ? "Salvataggio..." : "Salva transcript"}
            </button>
          </Show>
        </div>
      </div>
      <div
        class="placeholder"
        style={{ display: hasData() ? "none" : "block" }}
      >
        {placeholderText()}
      </div>
      <div
        class="timeline-body"
        style={{ display: hasData() ? "grid" : "none" }}
      >
        {/* Left column: fixed labels */}
        <div class="tl-labels">
          <div class="tl-label tl-label--ruler" />
          <Show
            when={alignmentMode()}
            fallback={
              <>
                <div class="tl-label tl-label--edl">EDL</div>
                <div class="tl-label tl-label--words" style={{ display: showWords() ? "flex" : "none" }}>Words</div>
                <div class="tl-label tl-label--captions" style={{ display: showCaptions() ? "flex" : "none" }}>Captions</div>
                <div class="tl-label tl-label--cuts" style={{ display: showCuts() ? "flex" : "none" }}>Cuts</div>
              </>
            }
          >
            <>
              <div class="tl-label tl-label--groups">Groups</div>
              <div class="tl-label tl-label--align-words">Words</div>
            </>
          </Show>
        </div>

        {/* Right column: scrollable tracks */}
        <div
          ref={viewportRef}
          class="timeline-viewport"
          onWheel={onWheel}
          onScroll={updateScrollFracs}
        >
          <div
            ref={innerRef}
            class="timeline-scroll-inner"
            style={{ width: `${totalWidth()}px` }}
            onPointerDown={onPointerDown}
          >
            {/* Playhead */}
            <div class="tl-playhead" style={{ left: `${playheadPx()}px` }} />

            {/* Ruler */}
            <div class="tl-ruler">
              <For each={rulerTicks()}>
                {(tick) => (
                  <>
                    <div
                      class={`tl-ruler-tick${tick.major ? " major" : ""}`}
                      style={{ left: `${toPx(tick.sec)}px` }}
                    />
                    {tick.major && (
                      <span class="tl-ruler-label" style={{ left: `${toPx(tick.sec)}px` }}>
                        {fmtTimePrecise(tick.sec)}
                      </span>
                    )}
                  </>
                )}
              </For>
            </div>

            <Show
              when={alignmentMode()}
              fallback={
                <>
                  {/* Track: EDL Keep Ranges */}
                  <div class="tl-track tl-track--edl">
                    <For each={ranges()}>
                      {(r) => {
                        const tip = `KEEP  ${fmtTimePrecise(r.start)} → ${fmtTimePrecise(r.end)}\n${r.reason}`;
                        return (
                          <div
                            class="tl-seg tl-seg--keep"
                            style={{ left: `${toPx(r.start)}px`, width: `${Math.max(3, toPx(r.end) - toPx(r.start))}px` }}
                            onMouseEnter={(e) => onSegmentEnter(e, tip)}
                            onMouseLeave={onSegmentLeave}
                          >
                            <span>{r.reason}</span>
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  {/* Track: Labeled Words */}
                  <div class="tl-track tl-track--words" style={{ display: showWords() ? "block" : "none" }}>
                    <For each={spans()}>
                      {(s) => {
                        const tip = `"${s.text}"  [${s.label}]\n${fmtTimePrecise(s.start)} → ${fmtTimePrecise(s.end)}`;
                        return (
                          <div
                            class={`tl-seg tl-seg--word ${s.label}`}
                            style={{ left: `${toPx(s.start)}px`, width: `${Math.max(3, toPx(s.end) - toPx(s.start))}px` }}
                            onMouseEnter={(e) => onSegmentEnter(e, tip)}
                            onMouseLeave={onSegmentLeave}
                          >
                            <span>{s.text}</span>
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  {/* Track: Caption Chunks */}
                  <div class="tl-track tl-track--captions" style={{ display: showCaptions() ? "block" : "none" }}>
                    <For each={captions()}>
                      {(c) => {
                        const words = (c.display_words || []).join(" ");
                        const tip = `Caption: "${words}"\n${fmtTimePrecise(c.start)} → ${fmtTimePrecise(c.end)}`;
                        return (
                          <div
                            class="tl-seg tl-seg--caption"
                            style={{ left: `${toPx(c.start)}px`, width: `${Math.max(3, toPx(c.end) - toPx(c.start))}px` }}
                            onMouseEnter={(e) => onSegmentEnter(e, tip)}
                            onMouseLeave={onSegmentLeave}
                          >
                            <span>{words}</span>
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  {/* Track: Soft Cuts */}
                  <div class="tl-track tl-track--cuts" style={{ display: showCuts() ? "block" : "none" }}>
                    <For each={cuts()}>
                      {(c) => (
                        <div
                          class="tl-cut"
                          style={{ left: `${toPx(c.at)}px` }}
                          onMouseEnter={(e) => onSegmentEnter(e, `Cut @ ${fmtTimePrecise(c.at)}\nfade: ${c.at}ms`)}
                          onMouseLeave={onSegmentLeave}
                        />
                      )}
                    </For>
                  </div>
                </>
              }
            >
              <>
                <div class="tl-track tl-track--groups">
                  <For each={alignmentSegments()}>
                    {(segment, segIdx) => {
                      const tip = `Group ${segIdx() + 1}\n${fmtTimePrecise(segment.start)} → ${fmtTimePrecise(segment.end)}\n${segment.text}`;
                      return (
                        <div
                          class="tl-seg tl-seg--group"
                          style={{
                            left: `${toPx(segment.start)}px`,
                            width: `${Math.max(4, toPx(segment.end) - toPx(segment.start))}px`,
                          }}
                          onMouseEnter={(e) => onSegmentEnter(e, tip)}
                          onMouseLeave={onSegmentLeave}
                        >
                          <span>{segment.text}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
                <div class="tl-track tl-track--align-words">
                  <For each={alignmentSegments()}>
                    {(segment, segIdx) => (
                      <For each={segment.words}>
                        {(word, wordIdx) => {
                          const isActive = () => {
                            const active = activeAlignmentWord();
                            return active?.seg === segIdx() && active.word === wordIdx();
                          };
                          const tip = `${word.text}\n${fmtTimePrecise(word.start)} → ${fmtTimePrecise(word.end)}`;
                          return (
                            <button
                              type="button"
                              class={`tl-seg tl-seg--align-word${isActive() ? " is-active" : ""}`}
                              style={{
                                left: `${toPx(word.start)}px`,
                                width: `${Math.max(6, toPx(word.end) - toPx(word.start))}px`,
                              }}
                              onMouseEnter={(e) => onSegmentEnter(e, tip)}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.cursor = canEditAlignment() ? "pointer" : "default";
                                onSegmentLeave();
                              }}
                              onPointerMove={(e) => {
                                const edge = canEditAlignment() ? edgeFromPointer(e.currentTarget, e.clientX) : null;
                                e.currentTarget.style.cursor = edge ? "ew-resize" : (canEditAlignment() ? "pointer" : "default");
                              }}
                              onPointerDown={(e) => {
                                if (!canEditAlignment()) return;
                                const edge = edgeFromPointer(e.currentTarget, e.clientX);
                                if (edge) {
                                  beginAlignmentResize(e, segIdx(), wordIdx(), edge);
                                  return;
                                }
                                e.stopPropagation();
                                setActiveAlignmentWord({ seg: segIdx(), word: wordIdx() });
                                setSeekRequest(word.start);
                              }}
                              onDblClick={() => setSeekRequest(word.start)}
                            >
                              <span>{word.text}</span>
                            </button>
                          );
                        }}
                      </For>
                    )}
                  </For>
                </div>
              </>
            </Show>
          </div>
        </div>
      </div>

      {/* Minimap — shows entire timeline overview when zoomed in */}
      <div
        class="tl-minimap"
        style={{ display: showOverview() ? "grid" : "none" }}
      >
        <div class="tl-minimap-label">Overall</div>
        <div
          class="tl-minimap-content"
          onPointerDown={(e) => {
            if (!viewportRef) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            viewportRef.scrollLeft = frac * totalWidth() - viewportRef.clientWidth / 2;

            const onMove = (ev: PointerEvent) => {
              const f2 = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
              viewportRef!.scrollLeft = f2 * totalWidth() - viewportRef!.clientWidth / 2;
            };
            const onUp = () => {
              document.removeEventListener("pointermove", onMove);
              document.removeEventListener("pointerup", onUp);
            };
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
          }}
        >
          <For each={overviewSegments()}>
            {(segment) => (
              <div
                class={`tl-mini-seg tl-mini-seg--${segment.tone}`}
                style={{
                  left: `${(segment.start / duration()) * 100}%`,
                  width: `${Math.max(0.3, ((segment.end - segment.start) / duration()) * 100)}%`,
                }}
              />
            )}
          </For>
          <For each={overviewCuts()}>
            {(c) => (
              <div
                class="tl-mini-cut"
                style={{ left: `${(c.at / duration()) * 100}%` }}
              />
            )}
          </For>
          <div
            class="tl-mini-playhead"
            style={{ left: `${duration() > 0 ? (playheadTime() / duration()) * 100 : 0}%` }}
          />
          <div
            class="tl-mini-viewport"
            style={{
              left: `${scrollFrac() * 100}%`,
              width: `${viewFrac() * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Tooltip */}
      <div
        class="tl-tooltip"
        style={{
          display: tooltip() ? "block" : "none",
          left: `${tooltip()?.x ?? 0}px`,
          top: `${(tooltip()?.y ?? 0) - 6}px`,
        }}
      >
        {tooltip()?.text}
      </div>
    </div>
  );
};

/* ---- Outputs ---- */

const OutputsPanel: Component = () => {
  const job = useJob();
  const outputs = createMemo(() => (job.data as JobSnapshot | undefined)?.outputs ?? []);
  const jobId = () => (job.data as JobSnapshot | undefined)?.id;

  return (
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Output</span>
      </div>
      <div class="outputs-rack">
        <div
          class="placeholder"
          style={{ display: outputs().length > 0 ? "none" : "block" }}
        >
          Nessun output disponibile
        </div>
        <For each={outputs()}>
          {(path) => (
            <button
              type="button"
              class="output-card"
              onClick={() => {
                const id = jobId();
                if (!id) return;
                const type = inferFileType(path);
                if (type === "video" || type === "audio") {
                  setMonitorForJob(id, path);
                } else {
                  setPreviewForJob(id, path);
                }
              }}
            >
              <span class="output-label">{humanizeMediaName(path)}</span>
              <span>{baseName(path)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
};


export default Workspace;
