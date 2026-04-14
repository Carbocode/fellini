import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, type Accessor, type Component, type JSX } from "solid-js";
import {
  IconArrowsMoveHorizontal,
  IconChevronRight,
  IconCrop,
  IconMovie,
  IconScissors,
  IconStack2,
  IconVideo,
  IconWaveSquare,
} from "@tabler/icons-solidjs";
import {
  selectedJobId,
  selectedClipId,
  selectedSubtitleId,
  selectedTrackId,
  setSelectedSubtitleId,
} from "../store";
import type { ClipCrop, ClipTranscriptionOptions, ClipTransform, EditorialProject } from "../types";
import {
  useJobQuery,
  useStartBackgroundRemovalMutation,
  useTranscribeClipMutation,
} from "../api/queries";
import {
  assetById,
  getClip,
  getSubtitleBlock,
  getTrack,
  patchSubtitle,
  removeSubtitle,
  setStoryLane,
  trackClips,
} from "../lib/editorial";
import { baseName, fmtTimePrecise } from "../lib/utils";

const ASR_LANGUAGE_OPTIONS = [
  { value: "it" },
  { value: "en" },
  { value: "es" },
  { value: "fr" },
  { value: "de" },
  { value: "pt" },
  { value: "nl" },
];

const ASR_MODEL_OPTIONS = [
  { value: "large-v3", label: "large-v3" },
  { value: "distil-large-v3", label: "distil-large-v3" },
  { value: "medium", label: "medium" },
  { value: "medium.en", label: "medium.en" },
  { value: "small", label: "small" },
  { value: "small.en", label: "small.en" },
  { value: "base", label: "base" },
  { value: "base.en", label: "base.en" },
  { value: "tiny", label: "tiny" },
  { value: "tiny.en", label: "tiny.en" },
];

type InspectorTab = "video" | "lane" | "audio" | "file";

// --------------- DragNumber ---------------
// Click senza drag → entra in edit mode. Drag orizzontale → cambia valore.
// Lo stato di drag viene tracciato internamente: snapshot di props.value al mousedown,
// accumulo delta in locale, così non dipende dalla reattività del parent durante il drag.
const DragNumber: Component<{
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unitsPerPixel?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}> = (props) => {
  let inputRef: HTMLInputElement | undefined;
  const [editing, setEditing] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const step = () => props.step ?? 1;
  const unitsPerPixel = () => props.unitsPerPixel ?? step();
  const fmt = () => props.format ?? ((v: number) => {
    const s = step();
    if (s >= 1) return String(Math.round(v));
    if (s >= 0.1) return v.toFixed(1);
    if (s >= 0.01) return v.toFixed(2);
    return v.toFixed(3);
  });
  const clamp = (v: number) => {
    let out = v;
    if (props.min !== undefined) out = Math.max(props.min, out);
    if (props.max !== undefined) out = Math.min(props.max, out);
    return out;
  };
  const snap = (v: number) => {
    const s = step();
    return parseFloat((Math.round(v / s) * s).toFixed(10));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (editing()) return;
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startValue = props.value;
    let last = startValue;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const totalDx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(totalDx) < 3) return;
        moved = true;
        setDragging(true);
        document.body.style.cursor = "ew-resize";
      }
      const raw = startValue + totalDx * unitsPerPixel();
      const next = clamp(snap(raw));
      if (next !== last) {
        last = next;
        props.onChange(next);
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setDragging(false);
      if (!moved) {
        setDraft(String(props.value));
        setEditing(true);
        setTimeout(() => { inputRef?.focus(); inputRef?.select(); }, 0);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitDraft = () => {
    const v = parseFloat(draft());
    if (!Number.isNaN(v)) props.onChange(clamp(v));
    setEditing(false);
  };

  return (
    <div class={`drag-number${dragging() ? " is-dragging" : ""}`} onMouseDown={onMouseDown}>
      <Show
        when={editing()}
        fallback={<span class="drag-number-value">{fmt()(props.value)}</span>}
      >
        <input
          ref={inputRef}
          class="drag-number-input"
          type="number"
          step={step()}
          value={draft()}
          onMouseDown={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </Show>
    </div>
  );
};

// --------------- JoystickPad ---------------
// Pad 2D trascinabile: ogni pixel di drag = delta su X/Y.
const JoystickPad: Component<{
  onDelta: (dx: number, dy: number) => void;
}> = (props) => {
  const [handlePos, setHandlePos] = createSignal({ x: 0, y: 0 });
  const [active, setActive] = createSignal(false);
  const PAD = 56; // raggio pad in px

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setActive(true);
    let lastX = e.clientX;
    let lastY = e.clientY;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      setHandlePos((prev) => ({
        x: Math.max(-PAD, Math.min(PAD, prev.x + dx)),
        y: Math.max(-PAD, Math.min(PAD, prev.y + dy)),
      }));
      props.onDelta(dx, dy);
    };

    const onUp = () => {
      setActive(false);
      // snap back to center
      setHandlePos({ x: 0, y: 0 });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      class={`joystick-pad${active() ? " is-active" : ""}`}
      onMouseDown={onMouseDown}
      title="Trascina per spostare la clip"
    >
      <div class="joystick-crosshair joystick-crosshair--h" />
      <div class="joystick-crosshair joystick-crosshair--v" />
      <div
        class="joystick-handle"
        style={{ transform: `translate(calc(-50% + ${handlePos().x}px), calc(-50% + ${handlePos().y}px))` }}
      />
    </div>
  );
};

const InspectorAccordion: Component<{
  icon: JSX.Element;
  title: string;
  meta?: string;
  open?: boolean;
  class?: string;
  children?: JSX.Element;
}> = (props) => (
  <details class={`inspector-accordion${props.class ? ` ${props.class}` : ""}`} open={props.open}>
    <summary class="inspector-accordion-summary">
      <div class="inspector-accordion-head">
        <span class="inspector-accordion-symbol" aria-hidden="true">{props.icon}</span>
        <div class="inspector-accordion-copy">
          <span class="inspector-accordion-title">{props.title}</span>
          <Show when={props.meta}>
            <span class="inspector-accordion-meta">{props.meta}</span>
          </Show>
        </div>
      </div>
      <span class="inspector-accordion-caret" aria-hidden="true"><IconChevronRight /></span>
    </summary>
    <div class="inspector-accordion-body">{props.children}</div>
  </details>
);

const ParamsInspector: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: EditorialProject | ((current: EditorialProject) => EditorialProject)) => void;
}> = (props) => {
  const job = useJobQuery(selectedJobId);
  const startBackgroundRemoval = useStartBackgroundRemovalMutation();
  const transcribeClip = useTranscribeClipMutation();
  const [activeTab, setActiveTab] = createSignal<InspectorTab>("lane");
  const currentTrack = createMemo(() => {
    const project = props.project();
    const clip = project ? getClip(project, selectedClipId()) : null;
    if (project && clip) return getTrack(project, clip.track_id) ?? null;
    return project ? getTrack(project, selectedTrackId()) : null;
  });
  const currentClip = createMemo(() => {
    const project = props.project();
    return project ? getClip(project, selectedClipId()) : null;
  });
  const currentSubtitle = createMemo(() => {
    const project = props.project();
    return project ? getSubtitleBlock(project, selectedSubtitleId()) : null;
  });
  const currentAsset = createMemo(() => {
    const project = props.project();
    const clip = currentClip();
    return project && clip ? assetById(project, clip.asset_id) ?? null : null;
  });
  const backgroundRemoval = createMemo(() => currentAsset()?.background_removal ?? null);
  const currentClipTranscriptionWords = createMemo(() => {
    const project = props.project();
    const clip = currentClip();
    if (!project || !clip) return [];
    const transcription = project.asset_transcriptions.find((item) => item.asset_id === clip.asset_id);
    if (!transcription) return [];
    return transcription.words
      .filter((word) => word.end > clip.source_in && word.start < clip.source_out)
      .sort((left, right) => (left.start - right.start) || (left.end - right.end) || left.id.localeCompare(right.id));
  });
  const currentClipTranscriptionWordCount = createMemo(() => currentClipTranscriptionWords().length);
  const currentTranscriptionStep = createMemo(() =>
    (job.data?.steps ?? []).find((step) => step.name === "transcription") ?? null
  );
  const currentClipTranscriptPreview = createMemo(() =>
    currentClipTranscriptionWords().map((word) => word.text).join(" ").trim()
  );
  const effectiveClipLanguage = createMemo(() =>
    currentClip()?.transcription_options.language?.trim() || job.data?.request.language || "it"
  );
  const effectiveClipModel = createMemo(() =>
    currentClip()?.transcription_options.model?.trim() || job.data?.request.transcription.model || "large-v3"
  );
  const effectiveClipBeamSize = createMemo(() =>
    currentClip()?.transcription_options.beam_size ?? job.data?.request.transcription.beam_size ?? 5
  );
  const effectiveClipVadFilter = createMemo(() =>
    currentClip()?.transcription_options.vad_filter ?? job.data?.request.transcription.vad_filter ?? true
  );
  const effectiveClipWhisperX = createMemo(() =>
    currentClip()?.transcription_options.use_whisperx ?? job.data?.request.toggles.use_whisperx ?? true
  );
  const updateClipTranscriptionOptions = (patch: Partial<ClipTranscriptionOptions>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) => (
        item.id === clip.id
          ? {
              ...item,
              transcription_options: {
                ...item.transcription_options,
                ...patch,
              },
            }
          : item
      )),
    }));
  };
  const updateClipTransform = (patch: Partial<ClipTransform>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) =>
        item.id === clip.id
          ? { ...item, transform: { ...item.transform, ...patch } }
          : item
      ),
    }));
  };
  const updateClipCrop = (patch: Partial<ClipCrop>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) =>
        item.id === clip.id
          ? { ...item, transform: { ...item.transform, crop: { ...item.transform.crop, ...patch } } }
          : item
      ),
    }));
  };

  const deleteSelectedSubtitle = () => {
    const subtitle = currentSubtitle();
    if (!subtitle) return;
    props.updateProject((project) => removeSubtitle(project, subtitle.id));
    setSelectedSubtitleId(null);
  };
  const runBackgroundRemoval = () => {
    const jobId = selectedJobId();
    const asset = currentAsset();
    if (!jobId || !asset || asset.kind !== "video") return;
    startBackgroundRemoval.mutate({ jobId, assetId: asset.id });
  };
  const canTranscribeClip = createMemo(() => {
    const clip = currentClip();
    const asset = currentAsset();
    const track = currentTrack();
    return !!selectedJobId()
      && !!job.data
      && job.data.status !== "running"
      && !!clip
      && !!asset
      && track?.kind === "audio"
      && (asset.kind === "audio" || asset.has_audio)
      && clip.transcription_status !== "running";
  });
  const runClipTranscription = () => {
    const jobId = selectedJobId();
    const clip = currentClip();
    if (!jobId || !clip) return;
    transcribeClip.mutate({ jobId, clipId: clip.id, options: clip.transcription_options });
  };
  const clipTranscriptionButtonLabel = () => {
    const clip = currentClip();
    if (!clip) return "Trascrivi clip";
    if (clip.transcription_status === "running") return "Trascrizione in corso";
    if (clip.transcription_status === "completed") return "Rigenera sottotitoli";
    if (clip.transcription_status === "failed") return "Riprova trascrizione";
    return "Genera sottotitoli";
  };
  const switchClipVariant = (variant: "original" | "cutout") => {
    const clip = currentClip();
    const asset = currentAsset();
    const track = currentTrack();
    if (!clip || !asset || asset.kind !== "video" || track?.kind !== "video") return;
    if (variant === "cutout" && !asset.background_removal?.cutout_path) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) => (
        item.id === clip.id
          ? { ...item, asset_variant: variant }
          : item
      )),
    }));
  };
  const hasLaneSettings = createMemo(() => !!currentTrack() || !!currentSubtitle());
  const hasVideoSettings = createMemo(() => !!currentClip() && currentTrack()?.kind === "video");
  const hasAudioSettings = createMemo(() => !!currentClip() && currentTrack()?.kind === "audio");
  const hasFileSettings = createMemo(() => !!currentClip() && !!currentAsset());
  const preferredTab = createMemo<InspectorTab>(() => {
    if (hasAudioSettings()) return "audio";
    if (hasVideoSettings()) return "video";
    return "lane";
  });
  const isTabEnabled = (tab: InspectorTab) => (
    tab === "video" ? hasVideoSettings()
      : tab === "audio" ? hasAudioSettings()
        : tab === "file" ? hasFileSettings()
          : hasLaneSettings()
  );
  const selectTab = (tab: InspectorTab) => {
    if (!isTabEnabled(tab)) return;
    setActiveTab(tab);
  };
  createEffect(() => {
    const tab = activeTab();
    if (isTabEnabled(tab)) return;
    setActiveTab(preferredTab());
  });
  createEffect(
    on(
      () => `${selectedClipId() ?? ""}:${selectedSubtitleId() ?? ""}:${selectedTrackId() ?? ""}`,
      () => {
        if (selectedClipId()) {
          const nextTab = preferredTab();
          if (nextTab === "video" || nextTab === "audio") {
            setActiveTab(nextTab);
            return;
          }
        }
        if (selectedSubtitleId() || selectedTrackId()) setActiveTab("lane");
      },
    ),
  );

  const laneStats = createMemo(() => {
    const project = props.project();
    const track = currentTrack();
    if (!project || !track) return null;
    const clips = trackClips(project, track.id);
    const clipDurations = clips.map((clip) => Math.max(0, clip.source_out - clip.source_in));
    const totalClipDuration = clipDurations.reduce((sum, duration) => sum + duration, 0);
    const coverageStart = clips.length ? Math.min(...clips.map((clip) => clip.start)) : null;
    const coverageEnd = clips.length
      ? Math.max(...clips.map((clip) => clip.start + Math.max(0, clip.source_out - clip.source_in)))
      : null;
    const uniqueAssets = new Set(clips.map((clip) => clip.asset_id)).size;
    const linkedClips = clips.filter((clip) => clip.linked_group_id).length;
    const relatedCaptions = track.kind === "subtitle"
      ? project.captions.filter((caption) => caption.track_id === track.id)
      : project.captions.filter((caption) => caption.source_lane_id === track.id);
    const generatedCaptions = relatedCaptions.filter((caption) => caption.origin === "generated").length;
    return {
      clipCount: clips.length,
      uniqueAssets,
      totalClipDuration,
      coverageStart,
      coverageEnd,
      relatedCaptionCount: relatedCaptions.length,
      generatedCaptionCount: generatedCaptions,
      manualCaptionCount: relatedCaptions.length - generatedCaptions,
      linkedClipCount: linkedClips,
    };
  });

  const formatLaneCoverage = (start: number | null, end: number | null) =>
    start === null || end === null ? "Vuota" : `${fmtTimePrecise(start)} - ${fmtTimePrecise(end)}`;

  const renderLanePanel = () => {
    const track = currentTrack();
    const stats = laneStats();
    if (!track || !stats) return null;
    const captionLabel = track.kind === "subtitle" ? "Blocchi testo" : "Sottotitoli";
    const muteLabel = track.kind === "audio"
      ? (track.muted ? "Muted" : "Audible")
      : (track.muted ? "Muted" : "Active");
    return (
      <div class="inspector-lane-panel">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">Lane</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">{track.name}</span>
              <span class="timeline-mode-tag">{track.kind}</span>
              <Show when={track.kind === "audio" && track.role}>
                <span class={`inspector-lane-chip${track.role === "story" ? " is-story" : ""}`}>{track.role}</span>
              </Show>
            </div>
            <div class="inspector-lane-state-row">
              <span class={`inspector-lane-chip${track.visible ? " is-on" : ""}`}>{track.visible ? "Visible" : "Hidden"}</span>
              <span class={`inspector-lane-chip${track.muted ? "" : " is-on"}`}>{muteLabel}</span>
              <span class={`inspector-lane-chip${track.locked ? "" : " is-on"}`}>{track.locked ? "Locked" : "Editable"}</span>
              <Show when={track.auto_generated}>
                <span class="inspector-lane-chip">Auto</span>
              </Show>
            </div>
          </div>
          <Show when={track.kind === "audio"}>
            <button
              type="button"
              class={`btn btn-xs ${track.role === "story" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => props.updateProject((project) => setStoryLane(project, track.id))}
            >
              {track.role === "story" ? "Story lane" : "Set story"}
            </button>
          </Show>
        </div>

        <div class="inspector-lane-stat-grid">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Clip attive</span>
            <span class="inspector-lane-stat-value">{stats.clipCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Asset unici</span>
            <span class="inspector-lane-stat-value">{stats.uniqueAssets}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata montata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(stats.totalClipDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Copertura</span>
            <span class="inspector-lane-stat-value">{formatLaneCoverage(stats.coverageStart, stats.coverageEnd)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">{captionLabel}</span>
            <span class="inspector-lane-stat-value">{stats.relatedCaptionCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Clip linked</span>
            <span class="inspector-lane-stat-value">{stats.linkedClipCount}</span>
          </div>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Dettagli</div>
          <div class="inspector-card-row">
            <span>Nome</span>
            <span>{track.name}</span>
          </div>
          <div class="inspector-card-row">
            <span>Ordine timeline</span>
            <span>{track.order + 1}</span>
          </div>
          <div class="inspector-card-row">
            <span>Tipo</span>
            <span class="timeline-mode-tag">{track.kind}</span>
          </div>
          <Show when={track.kind === "audio" && track.role}>
            <div class="inspector-card-row">
              <span>Ruolo</span>
              <span>{track.role}</span>
            </div>
          </Show>
          <div class="inspector-card-row">
            <span>Sottotitoli generati</span>
            <span>{stats.generatedCaptionCount}</span>
          </div>
          <div class="inspector-card-row">
            <span>Sottotitoli manuali</span>
            <span>{stats.manualCaptionCount}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderSubtitlePanel = () => {
    const subtitle = currentSubtitle();
    if (!subtitle) return null;
    const subtitleDuration = Math.max(0, subtitle.end - subtitle.start);
    const wordCount = subtitle.text.trim() ? subtitle.text.trim().split(/\s+/).length : 0;
    return (
      <div class="inspector-lane-panel inspector-lane-panel--secondary">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">Sottotitolo</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">Blocco selezionato</span>
              <span class="timeline-mode-tag">text</span>
            </div>
            <div class="inspector-lane-meta">
              {fmtTimePrecise(subtitle.start)} - {fmtTimePrecise(subtitle.end)}
            </div>
          </div>
        </div>

        <div class="inspector-lane-stat-grid inspector-lane-stat-grid--compact">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(subtitleDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Parole</span>
            <span class="inspector-lane-stat-value">{wordCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Word refs</span>
            <span class="inspector-lane-stat-value">{subtitle.source_word_refs.length}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Origine</span>
            <span class="inspector-lane-stat-value">{subtitle.origin}</span>
          </div>
        </div>

        <label class="param-field">
          <span>Testo</span>
          <textarea
            value={subtitle.text}
            onInput={(e) =>
              props.updateProject((project) =>
                patchSubtitle(project, subtitle.id, { text: e.currentTarget.value })
              )}
          />
        </label>
        <div class="inspector-lane-field-row">
          <label class="param-field">
            <span>Start</span>
            <input
              type="number"
              step="0.01"
              value={subtitle.start}
              onInput={(e) =>
                props.updateProject((project) =>
                  patchSubtitle(project, subtitle.id, { start: Number(e.currentTarget.value) })
                )}
            />
          </label>
          <label class="param-field">
            <span>End</span>
            <input
              type="number"
              step="0.01"
              value={subtitle.end}
              onInput={(e) =>
                props.updateProject((project) =>
                  patchSubtitle(project, subtitle.id, { end: Number(e.currentTarget.value) })
                )}
            />
          </label>
        </div>
        <div class="inspector-card-actions">
          <button
            type="button"
            class="btn btn-xs btn-danger"
            onClick={deleteSelectedSubtitle}
          >
            Elimina blocco
          </button>
        </div>
      </div>
    );
  };

  const renderFilePanel = () => {
    const clip = currentClip();
    const asset = currentAsset();
    if (!clip || !asset) return null;
    const usedDuration = Math.max(0, clip.source_out - clip.source_in);
    const clipEnd = clip.start + usedDuration;
    const resolution = asset.width > 0 && asset.height > 0 ? `${asset.width} x ${asset.height}` : "n/a";
    const sampleRate = asset.sample_rate ? `${(asset.sample_rate / 1000).toFixed(asset.sample_rate % 1000 === 0 ? 0 : 1)} kHz` : "n/a";
    const fps = asset.fps > 0 ? asset.fps.toFixed(asset.fps % 1 === 0 ? 0 : 2) : "n/a";
    const previewReady = asset.preview?.original || asset.preview?.cutout ? "Available" : "Missing";
    return (
      <div class="inspector-lane-panel">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">File</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">{asset.label || baseName(asset.path)}</span>
              <span class="timeline-mode-tag">{asset.kind}</span>
              <span class="inspector-lane-chip">{clip.asset_variant}</span>
            </div>
            <div class="inspector-lane-meta">{baseName(asset.path)}</div>
          </div>
        </div>

        <div class="inspector-lane-stat-grid">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata file</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(asset.duration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata usata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(usedDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Risoluzione</span>
            <span class="inspector-lane-stat-value">{resolution}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">FPS</span>
            <span class="inspector-lane-stat-value">{fps}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Sample rate</span>
            <span class="inspector-lane-stat-value">{sampleRate}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Preview</span>
            <span class="inspector-lane-stat-value">{previewReady}</span>
          </div>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Uso nella clip</div>
          <div class="inspector-card-row">
            <span>Timeline</span>
            <span>{fmtTimePrecise(clip.start)} - {fmtTimePrecise(clipEnd)}</span>
          </div>
          <div class="inspector-card-row">
            <span>Source range</span>
            <span>{fmtTimePrecise(clip.source_in)} - {fmtTimePrecise(clip.source_out)}</span>
          </div>
          <div class="inspector-card-row">
            <span>Origine clip</span>
            <span>{clip.origin}</span>
          </div>
          <div class="inspector-card-row">
            <span>Link</span>
            <span>{clip.linked_group_id ? "A/V linked" : "Independent"}</span>
          </div>
          <div class="inspector-card-row">
            <span>Captions</span>
            <span>{clip.captions_enabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Metadata file</div>
          <div class="inspector-card-row">
            <span>Asset id</span>
            <span>{asset.id}</span>
          </div>
          <div class="inspector-card-row">
            <span>Origine file</span>
            <span>{asset.origin}</span>
          </div>
          <div class="inspector-card-row">
            <span>Audio embedded</span>
            <span>{asset.has_audio ? "Yes" : "No"}</span>
          </div>
          <Show when={asset.transcript_ref}>
            <div class="inspector-card-row">
              <span>Transcript ref</span>
              <span>{asset.transcript_ref}</span>
            </div>
          </Show>
          <div class="inspector-card-row inspector-card-row--stack">
            <span>Percorso</span>
            <span class="inspector-card-value--code">{asset.path}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderClipInfoAccordion = () => {
    const clip = currentClip();
    if (!clip) return null;
    return (
      <div class="inspector-accordion-stack">
        <InspectorAccordion icon={<IconMovie />} title="Clip" meta={currentAsset()?.label || "Clip"}>
          <div class="inspector-card-row">
            <span>Timeline</span>
            <span>{fmtTimePrecise(clip.start)} - {fmtTimePrecise(clip.start + (clip.source_out - clip.source_in))}</span>
          </div>
          <div class="inspector-card-row">
            <span>Source in</span>
            <span>{fmtTimePrecise(clip.source_in)}</span>
          </div>
          <div class="inspector-card-row">
            <span>Source out</span>
            <span>{fmtTimePrecise(clip.source_out)}</span>
          </div>
          <div class="inspector-card-row">
            <span>Origine</span>
            <span>{clip.origin}</span>
          </div>
          <div class="inspector-card-row">
            <span>Link</span>
            <span>{clip.linked_group_id ? "A/V linked" : "Independent"}</span>
          </div>
        </InspectorAccordion>
      </div>
    );
  };

  const renderAudioAccordion = () => {
    const clip = currentClip();
    if (!clip || currentTrack()?.kind !== "audio") return null;
    return (
      <div class="inspector-accordion-stack">
        <InspectorAccordion
          icon={<IconWaveSquare />}
          title="Trascrizione"
          meta={`${clip.transcription_status} / ${currentClipTranscriptionWordCount()} parole`}
        >
          <div class="inspector-subsection">
            <div class="inspector-card-title">Transcript</div>
            <div class="inspector-card-row">
              <span>Transcription</span>
              <span>{clip.transcription_status}</span>
            </div>
            <Show when={clip.transcription_message}>
              <div class="inspector-card-row">
                <span>Stato</span>
                <span>{clip.transcription_message}</span>
              </div>
            </Show>
            <Show when={clip.transcription_status === "running" && currentTranscriptionStep()}>
              {(step) => (
                <>
                  <div class="inspector-card-row">
                    <span>Progresso</span>
                    <span>{step().progress}%</span>
                  </div>
                  <Show when={step().message}>
                    <div class="inspector-card-row">
                      <span>Fase</span>
                      <span>{step().message}</span>
                    </div>
                  </Show>
                </>
              )}
            </Show>
            <div class="inspector-card-row">
              <span>Parole</span>
              <span>{currentClipTranscriptionWordCount()}</span>
            </div>
            <Show when={clip.transcription_source_audio_path}>
              <div class="inspector-card-row">
                <span>Audio bounce</span>
                <span>{clip.transcription_source_audio_path}</span>
              </div>
            </Show>
            <Show when={currentClipTranscriptPreview()}>
              <label class="param-field">
                <span>Anteprima transcript</span>
                <textarea value={currentClipTranscriptPreview()} readonly rows={4} />
              </label>
            </Show>
            <Show when={clip.transcription_status === "completed" && !currentClipTranscriptPreview() && !clip.transcription_message}>
              <div class="inspector-card-row">
                <span>Risultato</span>
                <span>Nessuna parola disponibile</span>
              </div>
            </Show>
            <Show when={clip.transcription_error}>
              <div class="step-message">{clip.transcription_error}</div>
            </Show>
            <div class="inspector-card-actions">
              <button
                type="button"
                class="btn btn-xs btn-primary"
                disabled={!canTranscribeClip()}
                onClick={runClipTranscription}
              >
                {clipTranscriptionButtonLabel()}
              </button>
            </div>
          </div>

          <div class="inspector-subsection">
            <div class="inspector-card-title">Setup ASR</div>
            <div class="inspector-card-row">
              <span>Lingua effettiva</span>
              <span>{effectiveClipLanguage()}</span>
            </div>
            <div class="inspector-card-row">
              <span>Modello</span>
              <span>{effectiveClipModel()}</span>
            </div>
            <label class="param-field">
              <span>Lingua clip</span>
              <select
                value={effectiveClipLanguage()}
                onChange={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ language: value });
                }}
              >
                <For each={ASR_LANGUAGE_OPTIONS}>
                  {(option) => <option value={option.value}>{option.value}</option>}
                </For>
              </select>
              <Show when={clip.transcription_options.language !== null}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  onClick={() => updateClipTranscriptionOptions({ language: null })}
                >
                  Reset
                </button>
              </Show>
            </label>
            <label class="param-field">
              <span>Modello ASR</span>
              <select
                value={effectiveClipModel()}
                onChange={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ model: value });
                }}
              >
                <For each={ASR_MODEL_OPTIONS}>
                  {(option) => <option value={option.value}>{option.label}</option>}
                </For>
              </select>
              <Show when={clip.transcription_options.model !== null}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  onClick={() => updateClipTranscriptionOptions({ model: null })}
                >
                  Reset
                </button>
              </Show>
            </label>
            <label class="param-field">
              <span>Beam size</span>
              <input
                type="number"
                min="1"
                max="10"
                placeholder={String(job.data?.request.transcription.beam_size ?? 5)}
                value={clip.transcription_options.beam_size ?? ""}
                onInput={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ beam_size: value ? Number(value) : null });
                }}
              />
            </label>
            <div class="inspector-card-row">
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={effectiveClipVadFilter()}
                  onChange={(e) => updateClipTranscriptionOptions({ vad_filter: e.currentTarget.checked })}
                />
                <span>VAD filter</span>
              </label>
              <Show when={clip.transcription_options.vad_filter !== null}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  onClick={() => updateClipTranscriptionOptions({ vad_filter: null })}
                >
                  Reset
                </button>
              </Show>
            </div>
            <div class="inspector-card-row">
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={effectiveClipWhisperX()}
                  onChange={(e) => updateClipTranscriptionOptions({ use_whisperx: e.currentTarget.checked })}
                />
                <span>WhisperX align</span>
              </label>
              <Show when={clip.transcription_options.use_whisperx !== null}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  onClick={() => updateClipTranscriptionOptions({ use_whisperx: null })}
                >
                  Reset
                </button>
              </Show>
            </div>
          </div>
        </InspectorAccordion>
      </div>
    );
  };

  const renderVideoAccordion = () => {
    // Accessors reattivi — NON catturare il clip in una const locale,
    // altrimenti le JSX expressions leggono sempre lo snapshot iniziale.
    const tx = () => currentClip()?.transform.x ?? 0;
    const ty = () => currentClip()?.transform.y ?? 0;
    const tScale = () => currentClip()?.transform.scale ?? 1;
    const tRot = () => currentClip()?.transform.rotation ?? 0;
    const tOpacity = () => currentClip()?.transform.opacity ?? 1;
    const cropLeft = () => currentClip()?.transform.crop.left ?? 0;
    const cropTop = () => currentClip()?.transform.crop.top ?? 0;
    const cropRight = () => currentClip()?.transform.crop.right ?? 0;
    const cropBottom = () => currentClip()?.transform.crop.bottom ?? 0;

    return (
      <Show when={(() => {
        const asset = currentAsset();
        const track = currentTrack();
        return !!currentClip() && asset?.kind === "video" && track?.kind === "video";
      })()}>
        <div class="inspector-accordion-stack">
          <InspectorAccordion
            icon={<IconArrowsMoveHorizontal />}
            title="Trasformazione"
            meta={`x:${Math.round(tx())} y:${Math.round(ty())} s:${tScale().toFixed(2)}`}
            open
          >
            {/* Posizione: campi X/Y verticali + joystick 2D */}
            <div class="transform-position-row">
              <div class="transform-xy-fields">
                <div class="transform-field">
                  <span class="transform-field-label">X</span>
                  <DragNumber
                    value={tx()}
                    step={1}
                    unitsPerPixel={1}
                    onChange={(v) => updateClipTransform({ x: v })}
                  />
                </div>
                <div class="transform-field">
                  <span class="transform-field-label">Y</span>
                  <DragNumber
                    value={ty()}
                    step={1}
                    unitsPerPixel={1}
                    onChange={(v) => updateClipTransform({ y: v })}
                  />
                </div>
              </div>
              <JoystickPad
                onDelta={(dx, dy) => {
                  const c = currentClip();
                  if (!c) return;
                  updateClipTransform({ x: c.transform.x + dx, y: c.transform.y + dy });
                }}
              />
            </div>

            {/* Scala, Rotazione, Opacità */}
            <div class="transform-grid">
              <div class="transform-field">
                <span class="transform-field-label">Scala</span>
                <DragNumber
                  value={tScale()}
                  min={0.01}
                  step={0.01}
                  unitsPerPixel={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => updateClipTransform({ scale: Math.max(0.01, v) })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Rot °</span>
                <DragNumber
                  value={tRot()}
                  min={-360}
                  max={360}
                  step={1}
                  unitsPerPixel={1}
                  onChange={(v) => updateClipTransform({ rotation: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Opacità</span>
                <DragNumber
                  value={tOpacity()}
                  min={0}
                  max={1}
                  step={0.01}
                  unitsPerPixel={0.005}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => updateClipTransform({ opacity: v })}
                />
              </div>
            </div>

            <div class="inspector-card-actions">
              <button
                type="button"
                class="btn btn-xs btn-ghost"
                onClick={() => updateClipTransform({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 })}
              >
                Reset
              </button>
            </div>
          </InspectorAccordion>

          <InspectorAccordion
            icon={<IconCrop />}
            title="Crop"
            meta={`L:${Math.round(cropLeft() * 100)}% T:${Math.round(cropTop() * 100)}% R:${Math.round(cropRight() * 100)}% B:${Math.round(cropBottom() * 100)}%`}
          >
            {/* Visualizzatore crop */}
            <div class="crop-preview">
              <div
                class="crop-preview-inner"
                style={{
                  left: `${cropLeft() * 100}%`,
                  top: `${cropTop() * 100}%`,
                  right: `${cropRight() * 100}%`,
                  bottom: `${cropBottom() * 100}%`,
                }}
              />
            </div>

            <div class="transform-grid transform-grid--2">
              <div class="transform-field">
                <span class="transform-field-label">← Sinistra</span>
                <DragNumber
                  value={cropLeft()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ left: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Destra →</span>
                <DragNumber
                  value={cropRight()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ right: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">↑ Alto</span>
                <DragNumber
                  value={cropTop()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ top: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Basso ↓</span>
                <DragNumber
                  value={cropBottom()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ bottom: v })}
                />
              </div>
            </div>
            <div class="inspector-card-actions">
              <button
                type="button"
                class="btn btn-xs btn-ghost"
                onClick={() => updateClipCrop({ left: 0, top: 0, right: 0, bottom: 0 })}
              >
                Reset crop
              </button>
            </div>
          </InspectorAccordion>

          <InspectorAccordion
            icon={<IconScissors />}
            title="Scontorno"
            meta={backgroundRemoval()?.status ?? "idle"}
          >
            <div class="inspector-card-actions inspector-card-actions--spread">
              <button
                type="button"
                class="btn btn-xs btn-primary"
                disabled={startBackgroundRemoval.isPending || backgroundRemoval()?.status === "running"}
                onClick={runBackgroundRemoval}
              >
                {backgroundRemoval()?.cutout_path ? "Rigenera scontorno" : "Scontorna video"}
              </button>
              <div class="inspector-segmented" role="group" aria-label="Variante clip">
                <button
                  type="button"
                  class={`inspector-segmented__option ${currentClip()?.asset_variant === "original" ? "is-active" : ""}`}
                  aria-pressed={currentClip()?.asset_variant === "original"}
                  disabled={backgroundRemoval()?.status === "running" || !backgroundRemoval()?.original_path}
                  onClick={() => switchClipVariant("original")}
                >
                  Originale
                </button>
                <button
                  type="button"
                  class={`inspector-segmented__option ${currentClip()?.asset_variant === "cutout" ? "is-active" : ""}`}
                  aria-pressed={currentClip()?.asset_variant === "cutout"}
                  disabled={backgroundRemoval()?.status === "running" || !backgroundRemoval()?.cutout_path}
                  onClick={() => switchClipVariant("cutout")}
                >
                  Scontornato
                </button>
              </div>
            </div>
            <div class="inspector-card-row">
              <span>Background removal</span>
              <span>{backgroundRemoval()?.status ?? "idle"}</span>
            </div>
            <Show when={backgroundRemoval()}>
              {(cutout) => (
                <>
                  <Show when={cutout().message}>
                    <div class="inspector-card-row">
                      <span>Stato</span>
                      <span>{cutout().message}</span>
                    </div>
                  </Show>
                  <Show when={cutout().status === "running"}>
                    <div class="inspector-card-row">
                      <span>Progresso</span>
                      <span>{Math.round((cutout().progress ?? 0) * 100)}%</span>
                    </div>
                  </Show>
                  <Show when={cutout().error}>
                    <div class="step-message">{cutout().error}</div>
                  </Show>
                </>
              )}
            </Show>
          </InspectorAccordion>
        </div>
      </Show>
    );
  };

  return (
    <div class="panel inspector-panel">
      <Show when={props.project()} fallback={<div class="placeholder inspector-panel-empty">Seleziona un progetto</div>}>
        <>
          <div class="inspector-panel-body">
            <Switch>
              <Match when={activeTab() === "video"}>
                <div class="inspector-panel-section">
                  <Show when={hasVideoSettings()} fallback={<div class="placeholder inspector-panel-empty">Nessuna impostazione video disponibile.</div>}>
                    <>
                      {renderVideoAccordion()}
                      {renderClipInfoAccordion()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "lane"}>
                <div class="inspector-panel-section">
                  <Show when={hasLaneSettings()} fallback={<div class="placeholder inspector-panel-empty">Seleziona una lane o un blocco testo dalla timeline.</div>}>
                    <>
                      {renderLanePanel()}
                      {renderSubtitlePanel()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "audio"}>
                <div class="inspector-panel-section">
                  <Show when={hasAudioSettings()} fallback={<div class="placeholder inspector-panel-empty">Nessuna impostazione audio disponibile.</div>}>
                    <>
                      {renderAudioAccordion()}
                      {renderClipInfoAccordion()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "file"}>
                <div class="inspector-panel-section">
                  <Show when={hasFileSettings()} fallback={<div class="placeholder inspector-panel-empty">Seleziona una clip per vedere il file sorgente.</div>}>
                    {renderFilePanel()}
                  </Show>
                </div>
              </Match>
            </Switch>
          </div>

          <div class="inspector-tabbar" role="tablist" aria-label="Categorie inspector">
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "video" ? " active" : ""}`}
              aria-selected={activeTab() === "video"}
              disabled={!hasVideoSettings()}
              onClick={() => selectTab("video")}
            >
              <IconVideo />
              Video
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "lane" ? " active" : ""}`}
              aria-selected={activeTab() === "lane"}
              disabled={!hasLaneSettings()}
              onClick={() => selectTab("lane")}
            >
              <IconStack2 />
              Lane
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "audio" ? " active" : ""}`}
              aria-selected={activeTab() === "audio"}
              disabled={!hasAudioSettings()}
              onClick={() => selectTab("audio")}
            >
              <IconWaveSquare />
              Audio
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "file" ? " active" : ""}`}
              aria-selected={activeTab() === "file"}
              disabled={!hasFileSettings()}
              onClick={() => selectTab("file")}
            >
              <IconMovie />
              File
            </button>
          </div>
        </>
      </Show>
    </div>
  );
};

export default ParamsInspector;
