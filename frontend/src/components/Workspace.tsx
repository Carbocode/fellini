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

const Workspace: Component = () => {
  const job = useJobQuery(selectedJobId);
  const hasJob = () => !!job.data;

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

  return (
    <main class="workspace">
      <Show when={hasJob()} fallback={<div class="empty-state"><div class="empty-content"><p>Caricamento progetto...</p></div></div>}>
        <div class="project-workspace">
          <PipelineBar />
          <WorkspaceGrid />
          <TimelinePanel />
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
        <OutputsPanel />
      </div>
      <div class="resize-handle" onPointerDown={onResizeStart} />
      <div class="inspector-col">
        <ParamsInspector />
        <ArtifactsPanel />
        <PreviewPanel />
        <LogsPanel />
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

  // Gaps between keep ranges (for minimap)
  const gaps = createMemo(() => {
    const r = ranges();
    const d = duration();
    if (!r.length || d <= 0) return [];
    const result: { start: number; end: number }[] = [];
    if (r[0].start > 0.01) result.push({ start: 0, end: r[0].start });
    for (let i = 1; i < r.length; i++) {
      if (r[i].start - r[i - 1].end > 0.01) {
        result.push({ start: r[i - 1].end, end: r[i].start });
      }
    }
    if (r[r.length - 1].end < d - 0.01) result.push({ start: r[r.length - 1].end, end: d });
    return result;
  });

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
        style={{ display: hasData() && !alignmentMode() && viewFrac() < 0.99 ? "grid" : "none" }}
      >
        <div class="tl-minimap-label" />
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
          <div class="tl-mini-full" />
          <For each={gaps()}>
            {(gap) => (
              <div
                class="tl-mini-seg tl-mini-gap"
                style={{
                  left: `${(gap.start / duration()) * 100}%`,
                  width: `${Math.max(0.3, ((gap.end - gap.start) / duration()) * 100)}%`,
                }}
              />
            )}
          </For>
          <For each={cuts()}>
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

/* ---- Artifacts ---- */

const ArtifactsPanel: Component = () => {
  const job = useJob();
  const data = () => job.data as JobSnapshot | undefined;
  const catalog = createMemo(() => {
    const j = data();
    return j ? buildArtifactCatalog(j) : [];
  });
  const jobId = () => data()?.id;
  const currentPreview = () => {
    const id = jobId();
    return id ? getPreviewForJob(id) : undefined;
  };

  return (
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Artefatti</span>
      </div>
      <div class="artifacts-rack">
        <div
          class="placeholder"
          style={{ display: catalog().length > 0 ? "none" : "block" }}
        >
          Nessun artefatto
        </div>
        <For each={catalog()}>
          {(item) => (
            <button
              type="button"
              class={`artifact-row${currentPreview() === item.path ? " active" : ""}`}
              onClick={() => {
                const id = jobId();
                if (id) setPreviewForJob(id, item.path);
              }}
            >
              <span class="artifact-step">{item.step}</span>
              <span class="artifact-name">{baseName(item.path)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
};

/* ---- Preview ---- */

const PreviewPanel: Component = () => {
  const job = useJob();
  const data = () => job.data as JobSnapshot | undefined;
  const jobId = () => data()?.id;

  const previewPath = createMemo(() => {
    const id = jobId();
    if (!id) return null;
    const j = data();
    if (!j) return null;
    const catalog = buildArtifactCatalog(j);
    const p = getPreviewForJob(id);
    if (p && catalog.some((item) => item.path === p)) return p;
    const preferred = [
      "06_edit_decision_list.json",
      "05_spans_labeled.json",
      "07_caption_display.json",
      "04_transcript_aligned.json",
      "03_transcript_raw.json",
      "01_media_probe.json",
    ];
    for (const suffix of preferred) {
      const match = catalog.find((i) => i.path.endsWith(suffix));
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

  const content = createMemo(() => {
    const entry = artifact.data;
    if (!entry) return null;
    return entry.type === "json" ? JSON.stringify(entry.data, null, 2) : entry.text;
  });

  return (
    <div class="panel preview-panel">
      <div class="panel-header">
        <span class="panel-title">Preview</span>
      </div>
      <div class="preview-content">
        <div
          class="placeholder"
          style={{ display: previewPath() ? "none" : "block" }}
        >
          Seleziona un artefatto
        </div>
        <div style={{ display: previewPath() ? "block" : "none" }}>
          <div class="preview-header">
            <strong>{previewName()}</strong>
            <a href={previewSrc() ?? "#"} target="_blank">
              Apri
            </a>
          </div>
          <div
            style={{
              display:
                content() !== null || artifact.isLoading ? "block" : "none",
            }}
          >
            {content() !== null ? (
              <pre>{content()}</pre>
            ) : (
              <div class="placeholder">
                {artifact.isLoading ? "Caricamento..." : "Preview non disponibile"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---- Logs ---- */

const LogsPanel: Component = () => {
  const job = useJob();
  const logs = createMemo(() => (job.data as JobSnapshot | undefined)?.logs ?? []);
  const error = () => (job.data as JobSnapshot | undefined)?.error;

  return (
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Log</span>
      </div>
      <div class="logs-content">
        <div
          class="placeholder"
          style={{ display: logs().length > 0 || error() ? "none" : "block" }}
        >
          Nessun log
        </div>
        <For each={[...logs()].reverse()}>
          {(line) => <div class="log-line">{line}</div>}
        </For>
        <div
          class="log-line error-label"
          style={{ display: error() ? "block" : "none" }}
        >
          {error()}
        </div>
      </div>
    </div>
  );
};

export default Workspace;
