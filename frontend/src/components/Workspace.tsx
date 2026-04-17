import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
  type Component,
} from "solid-js";
import {
  IconArrowsLeftRight,
  IconBracketsContain,
  IconCrop,
  IconEye,
  IconEyeOff,
  IconLayoutGrid,
  IconLayoutList,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMinus,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconPlayerTrackNext,
  IconPlayerTrackPrev,
  IconPlus,
  IconPointer,
  IconRepeat,
  IconScissors,
  IconSearch,
  IconSquareRoundedCheck,
  IconSquareRoundedX,
  IconTrash,
  IconTrashX,
  IconVideo,
  IconVolume2,
  IconVolumeOff,
  IconWaveSquare,
  IconX,
} from "@tabler/icons-solidjs";
import { useQueryClient } from "@tanstack/solid-query";
import WaveSurfer, { type WaveSurferOptions } from "wavesurfer.js";
import { Button, FormField, InfoRow, Input, Select, Textarea, Toggle, InspectorAccordion } from "./ui";
import {
  useDeleteEditorialAssetMutation,
  useEditorialProjectQuery,
  useJobPolling,
  useJobQuery,
  useRequestAssetPreviewsMutation,
  useRunStepMutation,
  useUpdateEditorialProjectMutation,
  useUpdateRequestMutation,
  useUploadEditorialAssetMutation,
} from "../api/queries";
import { fileUrl } from "../api/client";
import { extractVideoThumbnail } from "../lib/monitor/thumbnail";
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
  setTimelineRangeLoopEnabled,
  setTimelineRangeSelection,
  updateTabLabel,
  timelineRangeLoopEnabled,
  timelineRangeSelection,
} from "../store";
import type {
  AssetPreviewVariantKind,
  AssetPreviewBundle,
  AssetPreviewEntry,
  EditorialProject,
  JobRequest,
  JobSnapshot,
  ProjectAsset,
  SubtitleBlock,
  TimelineClip,
  TimelineTrack,
} from "../types";
import {
  assetById,
  compatibleTrack,
  createClipsForAssetDrop,
  editorialDecisionLabel,
  getClip,
  getSubtitleBlock,
  getTrack,
  generatedSubtitleGroupsForLane,
  isEditorialResultCaption,
  laneContentRange,
  linkedClips,
  mediaPathForClip,
  normalizeEditorialProject,
  patchSubtitle,
  projectDuration,
  removeClip,
  rippleDeleteClip,
  rippleDeleteRange,
  retargetClipGroup,
  resolveClipGroupStart,
  resolveClipGroupSlipDelta,
  resolveClipGroupTrimEndDelta,
  resolveClipGroupTrimStartDelta,
  setClipEnabled,
  sortedTracks,
  splitClip,
  subtitleTrack,
  syncGeneratedSubtitlesWithMovedAudioClips,
  trackClips,
  trackHeight,
  trackSubtitles,
  type SubtitleVisualGroup,
  type VideoMaskVisualGroup,
  upsertClips,
  videoMaskGroupsForLane,
  visibleTimelineCaptions,
} from "../lib/editorial";
import {
  compileMonitorComposition,
  type MonitorComposition,
} from "../lib/monitor/composition";
import {
  CanvasMonitorRuntime,
  type MonitorDiagnostics,
} from "../lib/monitor/runtime";
import {
  baseName,
  fmtTime,
  fmtTimePrecise,
  humanizeMediaName,
} from "../lib/utils";
import PipelineBar from "./PipelineBar";
import type { ToolStep } from "./PipelineBar";
import ParamsInspector from "./ParamsInspector";

const TIMELINE_SPLITTER_HEIGHT = 4;
const PANEL_SPLITTER_WIDTH = 4;
const MIN_TIMELINE_HEIGHT = 180;
const MIN_TOP_WORKSPACE_HEIGHT = 220;
const MIN_BROWSER_WIDTH = 220;
const MAX_BROWSER_WIDTH = 440;
const MIN_MONITOR_DEBUG_WIDTH = 176;
const MAX_MONITOR_DEBUG_WIDTH = 520;
const BASE_PX_PER_SEC = 30;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const DEFAULT_ZOOM_INDEX = 3;
const ZOOM_WHEEL_THRESHOLD = 18;
const TIMELINE_TAIL_RATIO = 0.5;
const TIMELINE_TAIL_MIN_SECONDS = 60;
const TIMELINE_TAIL_MAX_SECONDS = 600;
type TimelineTool =
  | "select"
  | "range"
  | "cut"
  | "delete"
  | "ripple_delete"
  | "trim"
  | "slip"
  | "disable"
  | "enable";
const RULER_MINOR_STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const RULER_MINOR_TARGET_PX = 10;
const RULER_LABEL_EVERY_N_TICKS = 10;
const TIMELINE_RULER_HEIGHT = 28;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "fellini:workspace-sidebar-collapsed";
const CLIP_PREVIEW_MIN_WIDTH_PX = 32;
const MIN_SUBTITLE_DURATION = 0.02;
const WAVEFORM_SAMPLES_PER_DEVICE_PIXEL = 1;
const WAVEFORM_MIN_RENDER_PEAKS = 64;
const WAVEFORM_MAX_RENDER_PEAKS = 65536;
const FRAME_STEP_EPSILON = 1e-9;
const JOB_TOOL_SIDEBAR_WIDTH = 360;
const EDITORIAL_STANDALONE_HEIGHT = Math.max(Math.ceil(trackHeight("subtitle") / 2), 36);
const CANVAS_PRESETS = [
  { id: "vertical", label: "Vertical", width: 1080, height: 1920 },
  { id: "landscape", label: "Landscape", width: 1920, height: 1080 },
  { id: "square", label: "Square", width: 1080, height: 1080 },
  { id: "hd-vertical", label: "Vertical HD", width: 720, height: 1280 },
] as const;

type ProjectUpdater = EditorialProject | ((current: EditorialProject) => EditorialProject);
type SidebarView = "assets" | "logs";
type WaveformData = {
  version: number;
  metric: string;
  channels: number;
  duration: number;
  bucket_count: number;
  values: number[];
};

const waveformDataCache = new Map<string, Promise<WaveformData> | WaveformData>();

function monitorCompositionSyncKey(value: MonitorComposition | null): string {
  if (!value) return "null";
  return JSON.stringify({
    duration: value.duration,
    sequence: value.sequence,
    videoLayers: value.videoLayers,
    audioClips: value.audioClips,
  });
}

function formatMonitorDebugTime(value: number | null): string {
  return value === null ? "—" : fmtTimePrecise(value);
}

function formatMonitorDebugUs(value: number | null): string {
  return value === null ? "—" : `${(value / 1_000_000).toFixed(3)}s`;
}

function cloneJobRequest(request: JobRequest): JobRequest {
  return JSON.parse(JSON.stringify(request)) as JobRequest;
}

function triggerBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  queueMicrotask(() => anchor.remove());
}

function evenDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.max(256, Math.round(value));
  return normalized % 2 === 0 ? normalized : normalized + 1;
}

const TimelineToolIcon: Component<{ tool: TimelineTool }> = (props) => {
  switch (props.tool) {
    case "select":
      return <IconPointer aria-hidden="true" />;
    case "range":
      return <IconBracketsContain aria-hidden="true" />;
    case "cut":
      return <IconScissors aria-hidden="true" />;
    case "delete":
      return <IconTrash aria-hidden="true" />;
    case "ripple_delete":
      return <IconTrashX aria-hidden="true" />;
    case "trim":
      return <IconCrop aria-hidden="true" />;
    case "slip":
      return <IconArrowsLeftRight aria-hidden="true" />;
    case "disable":
      return <IconSquareRoundedX aria-hidden="true" />;
    case "enable":
      return <IconSquareRoundedCheck aria-hidden="true" />;
  }
};

const TIMELINE_TOOL_BUTTONS: Array<{
  tool: TimelineTool;
  label: string;
  tooltip: string;
  danger?: boolean;
}> = [
  {
    tool: "select",
    label: "Select",
    tooltip: "Select: seleziona le clip e trascinale sulla timeline.",
  },
  {
    tool: "range",
    label: "Range",
    tooltip: "Range: trascina nel ruler o nello spazio vuoto per creare una selezione temporale.",
  },
  {
    tool: "cut",
    label: "Taglia",
    tooltip: "Taglia: clicca una clip per dividerla nel punto del mouse.",
  },
  {
    tool: "delete",
    label: "Delete",
    tooltip: "Delete: rimuove la clip selezionata e lascia il gap in timeline.",
    danger: true,
  },
  {
    tool: "ripple_delete",
    label: "Ripple Delete",
    tooltip: "Ripple Delete: rimuove la clip o la range attiva e richiude automaticamente il gap.",
    danger: true,
  },
  {
    tool: "trim",
    label: "Trim",
    tooltip: "Trim: trascina una clip per rifilarla dal lato più vicino al mouse.",
  },
  {
    tool: "slip",
    label: "Slip",
    tooltip: "Slip: trascina una clip per spostare il contenuto interno senza muoverla in timeline.",
  },
  {
    tool: "disable",
    label: "Disable",
    tooltip: "Disable: clicca una clip attiva per disabilitarla senza cancellarla.",
  },
  {
    tool: "enable",
    label: "Enable",
    tooltip: "Enable: clicca una clip disabilitata per riattivarla.",
  },
];

const TIMELINE_TOOL_GROUPS: TimelineTool[][] = [
  ["select"],
  ["range"],
  ["cut", "delete", "ripple_delete"],
  ["trim", "slip"],
  ["disable", "enable"],
];

function previewBundleForClip(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): AssetPreviewBundle | null {
  if (!asset?.preview) return null;
  if (trackKind === "audio") return asset.preview.original ?? null;
  return previewVariant === "mask" ? asset.preview.mask ?? null : asset.preview.original ?? null;
}

function clipPreviewEntry(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): AssetPreviewEntry | null {
  if (!asset) return null;
  const bundle = previewBundleForClip(asset, trackKind, previewVariant);
  if (trackKind === "video") {
    if (asset.kind !== "video") return null;
    return bundle?.filmstrip ?? null;
  }
  if (asset.kind !== "audio" && !asset.has_audio) return null;
  return bundle?.waveform ?? null;
}

function clipPreviewStatus(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): "missing" | "generating" | "ready" | "failed" {
  return clipPreviewEntry(asset, trackKind, previewVariant)?.status ?? "missing";
}

function assetSupportsClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): boolean {
  if (!asset) return false;
  if (trackKind === "video") {
    if (asset.kind !== "video") return false;
    return previewVariant !== "mask" || !!asset.background_removal?.mask_video_path;
  }
  return asset.kind === "audio" || asset.has_audio;
}

function shouldRequestClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): boolean {
  return (
    assetSupportsClipPreview(asset, trackKind, previewVariant)
    && clipPreviewStatus(asset, trackKind, previewVariant) === "missing"
  );
}

function hasGeneratingClipPreview(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): boolean {
  return (
    assetSupportsClipPreview(asset, trackKind, previewVariant)
    && clipPreviewStatus(asset, trackKind, previewVariant) === "generating"
  );
}

function shouldRequestAnyAssetPreview(asset: ProjectAsset | null | undefined): boolean {
  if (!asset) return false;
  const needsVideoOriginal = asset.kind === "video"
    && ((asset.preview?.original?.filmstrip?.status ?? "missing") === "missing");
  const needsVideoMask = asset.kind === "video"
    && !!asset.background_removal?.mask_video_path
    && ((asset.preview?.mask?.filmstrip?.status ?? "missing") === "missing");
  const needsAudioOriginal = (asset.kind === "audio" || asset.has_audio)
    && ((asset.preview?.original?.waveform?.status ?? "missing") === "missing");
  return needsVideoOriginal || needsVideoMask || needsAudioOriginal;
}

function previewRequestKey(
  asset: ProjectAsset | null | undefined,
  trackKind: "video" | "audio",
  previewVariant: AssetPreviewVariantKind = "original",
): string | null {
  if (!asset) return null;
  const status = clipPreviewStatus(asset, trackKind, previewVariant);
  const maskPath = previewVariant === "mask" ? (asset.background_removal?.mask_video_path ?? "") : "";
  return `${asset.id}:${trackKind}:${previewVariant}:${status}:${maskPath}`;
}

function projectShapeFingerprint(project: EditorialProject): string {
  return JSON.stringify({
    assetIds: project.assets.map((asset) => asset.id),
    trackIds: project.tracks.map((track) => track.id),
    clipRefs: project.clips.map((clip) => ({
      id: clip.id,
      asset_id: clip.asset_id,
      track_id: clip.track_id,
      linked_group_id: clip.linked_group_id,
    })),
    captionIds: project.captions.map((caption) => caption.id),
    assetTranscriptionIds: project.asset_transcriptions.map((item) => item.asset_id),
    laneTranscriptionIds: project.lane_transcriptions.map((item) => item.lane_id),
  });
}

function mergeRuntimeAssetState(
  current: EditorialProject,
  incoming: EditorialProject,
): EditorialProject {
  const incomingById = new Map(incoming.assets.map((asset) => [asset.id, asset]));
  const incomingClipById = new Map(incoming.clips.map((clip) => [clip.id, clip]));
  const incomingLaneById = new Map(incoming.lane_transcriptions.map((lane) => [lane.lane_id, lane]));
  return normalizeEditorialProject({
    ...current,
    revision: incoming.revision,
    updated_at: incoming.updated_at,
    assets: current.assets.map((asset) => {
      const nextAsset = incomingById.get(asset.id);
      if (!nextAsset) return asset;
      return {
        ...asset,
        path: nextAsset.path,
        duration: nextAsset.duration,
        width: nextAsset.width,
        height: nextAsset.height,
        fps: nextAsset.fps,
        sample_rate: nextAsset.sample_rate,
        has_audio: nextAsset.has_audio,
        preview: nextAsset.preview,
        background_removal: nextAsset.background_removal,
      };
    }),
    clips: current.clips.map((clip) => {
      const nextClip = incomingClipById.get(clip.id);
      if (!nextClip) return clip;
      return {
        ...clip,
        transcription_options: nextClip.transcription_options,
        transcription_status: nextClip.transcription_status,
        transcription_message: nextClip.transcription_message,
        transcription_source_audio_path: nextClip.transcription_source_audio_path,
        transcription_updated_at: nextClip.transcription_updated_at,
        transcription_error: nextClip.transcription_error,
      };
    }),
    lane_transcriptions: [
      ...current.lane_transcriptions.map((lane) => incomingLaneById.get(lane.lane_id) ?? lane),
      ...incoming.lane_transcriptions.filter((lane) => !current.lane_transcriptions.some(
        (currentLane) => currentLane.lane_id === lane.lane_id,
      )),
    ],
  });
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

function waveformSliceForClip(
  payload: WaveformData,
  clip: TimelineClip,
  assetDuration: number,
): { duration: number; values: number[] } {
  const values = payload.values;
  const totalDuration = Math.max(assetDuration, payload.duration, 0.01);
  const start = Math.max(0, Math.min(clip.source_in, totalDuration));
  const end = Math.max(start + 0.001, Math.min(clip.source_out, totalDuration));
  if (!values.length) {
    return {
      duration: Math.max(0.001, end - start),
      values: [0],
    };
  }
  const startIndex = Math.max(0, Math.min(values.length - 1, Math.floor((start / totalDuration) * values.length)));
  const endIndex = Math.max(startIndex + 1, Math.min(values.length, Math.ceil((end / totalDuration) * values.length)));
  return {
    duration: Math.max(0.001, end - start),
    values: values.slice(startIndex, endIndex),
  };
}

function targetWaveformPeakCount(displayWidth: number): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.max(
    WAVEFORM_MIN_RENDER_PEAKS,
    Math.min(
      WAVEFORM_MAX_RENDER_PEAKS,
      Math.ceil(Math.max(CLIP_PREVIEW_MIN_WIDTH_PX, displayWidth) * dpr * WAVEFORM_SAMPLES_PER_DEVICE_PIXEL),
    ),
  );
}

function resampleWaveformPeaks(values: number[], targetCount: number): Float32Array {
  const available = values.length;
  const count = Math.max(1, Math.min(targetCount, available || 1));
  const output = new Float32Array(count);
  if (!available) return output;
  if (count >= available) {
    for (let index = 0; index < available; index += 1) {
      output[index] = (values[index] ?? 0) / 255;
    }
    return output;
  }
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor((index / count) * available);
    const to = Math.min(
      available,
      Math.max(from + 1, Math.ceil(((index + 1) / count) * available)),
    );
    let peak = 0;
    for (let sourceIndex = from; sourceIndex < to; sourceIndex += 1) {
      peak = Math.max(peak, values[sourceIndex] ?? 0);
    }
    output[index] = peak / 255;
  }
  return output;
}

function renderContinuousWaveform(peaks: Array<Float32Array | number[]>, ctx: CanvasRenderingContext2D): void {
  const channel = peaks[0];
  if (!channel?.length) return;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const centerY = height / 2;
  const xScale = channel.length > 1 ? width / (channel.length - 1) : width;
  const strokeWidth = Math.max(1, Math.round(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  const amplitudeScale = height * 0.46;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(139, 231, 164, 0.84)";
  ctx.strokeStyle = "rgba(203, 255, 214, 0.32)";
  ctx.lineWidth = Math.max(1, strokeWidth * 0.75);

  ctx.beginPath();
  for (let index = 0; index < channel.length; index += 1) {
    const amplitude = Math.max(0, Math.min(1, Math.abs(channel[index] ?? 0)));
    const x = Math.min(width, index * xScale);
    const y = centerY - (amplitude * amplitudeScale);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let index = channel.length - 1; index >= 0; index -= 1) {
    const amplitude = Math.max(0, Math.min(1, Math.abs(channel[index] ?? 0)));
    const x = Math.min(width, index * xScale);
    const y = centerY + (amplitude * amplitudeScale);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function buildStepRequestPayload(step: ToolStep, draft: JobRequest): Record<string, unknown> {
  if (step === "editorial") {
    return {
      language: draft.language.trim() || "it",
      editorial_notes: draft.editorial_notes,
      toggles: {
        use_local_llm: draft.toggles.use_local_llm,
      },
    };
  }

  return {
    render: {
      ...draft.render,
      width: evenDimension(draft.render.width, 1080),
      height: evenDimension(draft.render.height, 1920),
    },
  };
}

const StepConfigSidebar: Component<{
  step: Accessor<ToolStep | null>;
  job: Accessor<JobSnapshot | undefined>;
  onClose: () => void;
}> = (props) => {
  const updateRequest = useUpdateRequestMutation();
  const runStep = useRunStepMutation();
  const [draft, setDraft] = createSignal<JobRequest | null>(null);
  const [error, setError] = createSignal("");

  createEffect(
    on(
      () => [props.step(), props.job()?.id, props.job()?.updated_at] as const,
      () => {
        const currentStep = props.step();
        const currentJob = props.job();
        if (!currentStep || !currentJob) {
          setDraft(null);
          setError("");
          return;
        }
        setDraft(cloneJobRequest(currentJob.request));
        setError("");
      },
    ),
  );

  const activeStepLabel = createMemo(() =>
    props.step() === "editorial" ? "Editorial" : props.step() === "render" ? "Render" : "",
  );
  const stepSnapshot = createMemo(() => {
    const currentStep = props.step();
    const currentJob = props.job();
    if (!currentStep || !currentJob) return null;
    return currentJob.steps.find((step) => step.name === currentStep) ?? null;
  });
  const running = () => updateRequest.isPending || runStep.isPending;

  const updateDraft = (updater: (current: JobRequest) => JobRequest) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const applyCanvasPreset = (presetId: string) => {
    const preset = CANVAS_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    updateDraft((current) => ({
      ...current,
      render: {
        ...current.render,
        width: preset.width,
        height: preset.height,
      },
    }));
  };

  const submit = async () => {
    const currentStep = props.step();
    const currentJob = props.job();
    const currentDraft = draft();
    if (!currentStep || !currentJob || !currentDraft || !stepSnapshot()?.can_run) return;
    setError("");
    try {
      const payload = buildStepRequestPayload(currentStep, currentDraft);
      await updateRequest.mutateAsync({ jobId: currentJob.id, payload });
      await runStep.mutateAsync({ jobId: currentJob.id, stepName: currentStep });
      props.onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Errore durante l'avvio del job.");
    }
  };

  return (
    <Show when={props.step() && draft()}>
      <aside class="job-tool-sidebar">
        <div class="job-tool-sidebar__body">
          <div class="inspector-accordion-stack">
          <Show when={props.step() === "editorial" && draft()}>
            {(currentDraft) => (
              <InspectorAccordion icon={<IconScissors />} title="Decisione editoriale" meta="LLM + note" open>
                  <FormField label="Lingua">
                    <Input
                      value={currentDraft().language}
                      onInput={(event) =>
                        updateDraft((request) => ({ ...request, language: event.currentTarget.value }))
                      }
                    />
                  </FormField>
                  <InfoRow label="">
                    <Toggle
                      label="Usa local LLM"
                      checked={currentDraft().toggles.use_local_llm}
                      onChange={(event) =>
                        updateDraft((request) => ({
                          ...request,
                          toggles: {
                            ...request.toggles,
                            use_local_llm: (event.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                  </InfoRow>
                  <FormField label="Note editoriali">
                    <Textarea
                      rows="8"
                      value={currentDraft().editorial_notes}
                      placeholder="Hook, tono, pacing, vincoli di taglio, CTA..."
                      onInput={(event) =>
                        updateDraft((request) => ({
                          ...request,
                          editorial_notes: event.currentTarget.value,
                        }))
                      }
                    />
                  </FormField>
              </InspectorAccordion>
            )}
          </Show>

          <Show when={props.step() === "render" && draft()}>
            {(currentDraft) => (
              <>
                <InspectorAccordion icon={<IconVideo />} title="Output" meta="Unico export finale" open>
                    <p class="inspector-note">
                      Il render esporta una sola versione finale della timeline, coerente con il canvas della preview.
                    </p>
                </InspectorAccordion>

                <InspectorAccordion icon={<IconBracketsContain />} title="Canvas" meta={`${currentDraft().render.width}×${currentDraft().render.height}`} open>
                    <FormField label="Preset">
                      <Select
                        value={
                          CANVAS_PRESETS.find(
                            (preset) =>
                              preset.width === currentDraft().render.width
                              && preset.height === currentDraft().render.height,
                          )?.id ?? ""
                        }
                        onInput={(event) => applyCanvasPreset(event.currentTarget.value)}
                      >
                        <option value="">Custom</option>
                        <For each={CANVAS_PRESETS}>
                          {(preset) => (
                            <option value={preset.id}>
                              {preset.label} {preset.width}×{preset.height}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                    <div class="form-row" style={{ "grid-template-columns": "1fr 1fr" }}>
                      <FormField label="Width">
                        <Input
                          type="number"
                          min="256"
                          step="2"
                          value={currentDraft().render.width}
                          onInput={(event) =>
                            updateDraft((request) => ({
                              ...request,
                              render: {
                                ...request.render,
                                width: Number(event.currentTarget.value || request.render.width),
                              },
                            }))
                          }
                        />
                      </FormField>
                      <FormField label="Height">
                        <Input
                          type="number"
                          min="256"
                          step="2"
                          value={currentDraft().render.height}
                          onInput={(event) =>
                            updateDraft((request) => ({
                              ...request,
                              render: {
                                ...request.render,
                                height: Number(event.currentTarget.value || request.render.height),
                              },
                            }))
                          }
                        />
                      </FormField>
                    </div>
                </InspectorAccordion>

                <InspectorAccordion icon={<IconWaveSquare />} title="Encoding" meta="ffmpeg">
                    <div class="form-row" style={{ "grid-template-columns": "1fr 1fr" }}>
                      <FormField label="Video codec">
                        <Select
                          value={currentDraft().render.video_codec}
                          onInput={(event) =>
                            updateDraft((request) => ({
                              ...request,
                              render: { ...request.render, video_codec: event.currentTarget.value },
                            }))
                          }
                        >
                          <option value="libx264">libx264</option>
                          <option value="h264_videotoolbox">h264_videotoolbox</option>
                          <option value="hevc_videotoolbox">hevc_videotoolbox</option>
                        </Select>
                      </FormField>
                      <FormField label="Audio codec">
                        <Select
                          value={currentDraft().render.audio_codec}
                          onInput={(event) =>
                            updateDraft((request) => ({
                              ...request,
                              render: { ...request.render, audio_codec: event.currentTarget.value },
                            }))
                          }
                        >
                          <option value="aac">aac</option>
                          <option value="mp3">mp3</option>
                        </Select>
                      </FormField>
                    </div>
                    <div class="form-row" style={{ "grid-template-columns": "1fr 1fr 1fr" }}>
                    <FormField label="Preset">
                      <Select
                        value={currentDraft().render.preset}
                        onInput={(event) =>
                          updateDraft((request) => ({
                            ...request,
                            render: { ...request.render, preset: event.currentTarget.value },
                          }))
                        }
                      >
                        <option value="veryfast">veryfast</option>
                        <option value="faster">faster</option>
                        <option value="fast">fast</option>
                        <option value="medium">medium</option>
                        <option value="slow">slow</option>
                        <option value="slower">slower</option>
                      </Select>
                    </FormField>
                    <FormField label="CRF">
                      <Input
                        type="number"
                        min="0"
                        max="35"
                        value={currentDraft().render.crf}
                        onInput={(event) =>
                          updateDraft((request) => ({
                            ...request,
                            render: {
                              ...request.render,
                              crf: Number(event.currentTarget.value || request.render.crf),
                            },
                          }))
                        }
                      />
                    </FormField>
                    <FormField label="Audio bitrate">
                      <Input
                        value={currentDraft().render.audio_bitrate}
                        onInput={(event) =>
                          updateDraft((request) => ({
                            ...request,
                            render: {
                              ...request.render,
                              audio_bitrate: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </FormField>
                    </div>
                </InspectorAccordion>

              </>
            )}
          </Show>
          </div>
        </div>

        <div class="job-tool-sidebar__footer">
          <div class={`job-tool-sidebar__status${error() ? " error" : ""}`}>
            {error()
              || stepSnapshot()?.blocked_reason
              || (running() ? "Salvataggio configurazione e avvio job..." : "")}
          </div>
          <Button variant="ghost" onClick={props.onClose} disabled={running()}>
            Annulla
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={running() || !stepSnapshot()?.can_run}
          >
            Avvia {activeStepLabel()}
          </Button>
        </div>
      </aside>
    </Show>
  );
};

const WaveformClipPreview: Component<{
  src: string;
  clip: TimelineClip;
  assetDuration: number;
  pxPerSecond: number;
}> = (props) => {
  const [data, setData] = createSignal<WaveformData | null>(null);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let containerRef: HTMLDivElement | undefined;
  let waveformRef: WaveSurfer | undefined;

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

  const renderData = createMemo(() => {
    const payload = data();
    const width = size().width;
    const height = size().height;
    if (!payload || width <= 0 || height <= 0) return null;
    const slice = waveformSliceForClip(payload, props.clip, props.assetDuration);
    const effectiveWidth = Math.max(
      width,
      Math.max(CLIP_PREVIEW_MIN_WIDTH_PX, slice.duration * props.pxPerSecond),
    );
    return {
      duration: slice.duration,
      height,
      peaks: [resampleWaveformPeaks(slice.values, targetWaveformPeakCount(effectiveWidth))],
    };
  });

  createEffect(() => {
    if (renderData()) return;
    waveformRef?.empty();
  });

  createEffect(() => {
    const current = renderData();
    if (!containerRef || !current) return;
    const options = {
      peaks: current.peaks,
      duration: current.duration,
      height: current.height,
      width: "100%",
      fillParent: true,
      normalize: false,
      interact: false,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      cursorWidth: 0,
      waveColor: "rgba(139, 231, 164, 0.88)",
      progressColor: "rgba(139, 231, 164, 0.88)",
      renderFunction: renderContinuousWaveform,
    } satisfies Partial<WaveSurferOptions>;
    if (!waveformRef) {
      waveformRef = WaveSurfer.create({
        container: containerRef,
        ...options,
      });
      return;
    }
    waveformRef.setOptions(options);
  });

  onCleanup(() => {
    waveformRef?.destroy();
    waveformRef = undefined;
  });

  return <div ref={containerRef} class="tl-waveform-host" aria-hidden="true" />;
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
  pxPerSecond: number;
  previewVariant?: AssetPreviewVariantKind;
}> = (props) => {
  const previewVariant = () => props.previewVariant ?? "original";
  const entry = () => clipPreviewEntry(props.asset, props.trackKind, previewVariant());
  const status = () => entry()?.status ?? "missing";
  const src = () => {
    const preview = entry();
    const path = preview?.status === "ready" ? preview.resource_path : null;
    return path && preview ? `${fileUrl(props.jobId, path)}?v=${preview.version}` : null;
  };
  const clipDuration = () => Math.max(0.001, props.clip.source_out - props.clip.source_in);
  const assetDuration = () => Math.max(props.asset.duration, props.clip.source_out, clipDuration());

  return (
    <div
      class="tl-clip-preview-body"
      classList={{
        "has-media": !!src(),
        "is-loading": status() === "generating",
        "is-mask": previewVariant() === "mask",
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
            pxPerSecond={props.pxPerSecond}
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

const TimelineSubtitleSegment: Component<{
  caption: SubtitleBlock;
  left: number;
  width: number;
  selected: boolean;
  editing: boolean;
  editText: string;
  segmentClass?: string;
  onPointerDown: (event: PointerEvent, caption: SubtitleBlock) => void;
  onTrimPointerDown: (event: PointerEvent, caption: SubtitleBlock, edge: "start" | "end") => void;
  onSelect: (caption: SubtitleBlock) => void;
  onBeginEdit: (caption: SubtitleBlock) => void;
  onEditTextChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}> = (props) => {
  let inputRef: HTMLInputElement | undefined;
  const segmentWidth = () => Math.max(props.editing ? 48 : 8, props.width);
  const segmentClassName = () =>
    `tl-seg tl-seg--subtitle${props.segmentClass ? ` ${props.segmentClass}` : ""}${props.selected ? " is-active" : ""}${props.editing ? " tl-seg--subtitle-editing" : ""}`;

  createEffect(() => {
    if (!props.editing || !inputRef) return;
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  return (
    <Show
      when={!props.editing}
      fallback={
        <div
          class={segmentClassName()}
          style={{
            left: `${props.left}px`,
            width: `${segmentWidth()}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="text"
            class="tl-subtitle-inline-input"
            value={props.editText}
            onInput={(event) => props.onEditTextChange(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                props.onCommitEdit();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onCancelEdit();
              }
            }}
            onBlur={() => props.onCommitEdit()}
          />
        </div>
      }
    >
      <button
        type="button"
        class={segmentClassName()}
        style={{
          left: `${props.left}px`,
          width: `${segmentWidth()}px`,
        }}
        onPointerDown={(event) => props.onPointerDown(event, props.caption)}
        onClick={(event) => {
          event.stopPropagation();
          props.onSelect(props.caption);
        }}
        onDblClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onBeginEdit(props.caption);
        }}
        onKeyDown={(event) => {
          if (event.key !== "F2") return;
          event.preventDefault();
          event.stopPropagation();
          props.onBeginEdit(props.caption);
        }}
      >
        <span>{props.caption.text}</span>
        <div
          class="tl-subtitle-handle tl-subtitle-handle--start"
          onPointerDown={(event) => props.onTrimPointerDown(event, props.caption, "start")}
        />
        <div
          class="tl-subtitle-handle tl-subtitle-handle--end"
          onPointerDown={(event) => props.onTrimPointerDown(event, props.caption, "end")}
        />
      </button>
    </Show>
  );
};

const AudioSubtitleVisualGroup: Component<{
  group: SubtitleVisualGroup;
  pxPerSecond: number;
  selectedSubtitleId: string | null;
  editingSubtitleId: string | null;
  editingSubtitleText: string;
  onPointerDown: (event: PointerEvent, caption: SubtitleBlock) => void;
  onTrimPointerDown: (event: PointerEvent, caption: SubtitleBlock, edge: "start" | "end") => void;
  onSelect: (caption: SubtitleBlock) => void;
  onBeginEdit: (caption: SubtitleBlock) => void;
  onEditTextChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}> = (props) => (
  <div
    class={`tl-audio-subtitle-group${props.group.isFallback ? " is-fallback" : ""}`}
    style={{
      left: `${props.group.start * props.pxPerSecond}px`,
      width: `${Math.max(12, (props.group.end - props.group.start) * props.pxPerSecond)}px`,
    }}
  >
    <For each={props.group.captions}>
      {(caption) => (
        <TimelineSubtitleSegment
          caption={caption}
          left={Math.max(0, (caption.start - props.group.start) * props.pxPerSecond)}
          width={Math.max(8, (caption.end - caption.start) * props.pxPerSecond)}
          selected={props.selectedSubtitleId === caption.id}
          editing={props.editingSubtitleId === caption.id}
          editText={props.editingSubtitleId === caption.id ? props.editingSubtitleText : caption.text}
          segmentClass="tl-audio-subtitle-word"
          onPointerDown={props.onPointerDown}
          onTrimPointerDown={props.onTrimPointerDown}
          onSelect={props.onSelect}
          onBeginEdit={props.onBeginEdit}
          onEditTextChange={props.onEditTextChange}
          onCommitEdit={props.onCommitEdit}
          onCancelEdit={props.onCancelEdit}
        />
      )}
    </For>
  </div>
);

const TimelineVideoMaskGroup: Component<{
  jobId: string;
  group: VideoMaskVisualGroup;
  clip: TimelineClip;
  asset: ProjectAsset;
  pxPerSecond: number;
}> = (props) => (
  <div
    class={`tl-video-mask-group tl-video-mask-group--${props.group.status}`}
    style={{
      left: `${props.group.start * props.pxPerSecond}px`,
      width: `${Math.max(12, (props.group.end - props.group.start) * props.pxPerSecond)}px`,
    }}
  >
    <Show
      when={props.group.status === "ready"}
      fallback={
        <div class={`tl-video-mask-placeholder tl-video-mask-placeholder--${props.group.status}`}>
          <span>
            {props.group.status === "pending"
              ? "AI MASK"
              : props.group.status === "failed"
                ? "MASK ERROR"
                : "MASK"}
          </span>
        </div>
      }
    >
      <TimelineClipPreview
        jobId={props.jobId}
        clip={props.clip}
        asset={props.asset}
        trackKind="video"
        pxPerSecond={props.pxPerSecond}
        previewVariant="mask"
      />
    </Show>
  </div>
);

function formatRulerLabel(seconds: number, labelStep: number): string {
  if (labelStep < 1) {
    // Sub-second: show seconds with decimals
    const s = Math.abs(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m > 0) return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
    return `${sec.toFixed(2)}s`;
  }
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
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
  const [sidebarView, setSidebarView] = createSignal<SidebarView>("assets");
  const [activeToolSidebar, setActiveToolSidebar] = createSignal<ToolStep | null>(null);
  let pendingRenderDownloadJobId: string | null = null;
  const downloadedRenderKeys = new Set<string>();
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
  createEffect(
    on(
      () => {
        const snapshot = data();
        const renderStep = snapshot?.steps.find((step) => step.name === "render") ?? null;
        return {
          jobId: selectedJobId(),
          status: snapshot?.status ?? null,
          currentStep: snapshot?.current_step ?? null,
          output: snapshot?.outputs[0] ?? null,
          renderStatus: renderStep?.status ?? null,
          renderFinishedAt: renderStep?.finished_at ?? null,
        } as const;
      },
      (state) => {
        if (!state.jobId) {
          pendingRenderDownloadJobId = null;
          return;
        }
        if (pendingRenderDownloadJobId && pendingRenderDownloadJobId !== state.jobId) {
          pendingRenderDownloadJobId = null;
        }
        if (state.status === "running" && state.currentStep === "render") {
          pendingRenderDownloadJobId = state.jobId;
          return;
        }
        if (state.status === "failed" && pendingRenderDownloadJobId === state.jobId) {
          pendingRenderDownloadJobId = null;
          return;
        }
        if (
          state.status !== "completed"
          || state.renderStatus !== "completed"
          || pendingRenderDownloadJobId !== state.jobId
          || !state.output
        ) {
          return;
        }
        const downloadKey = `${state.jobId}:${state.renderFinishedAt ?? ""}:${state.output}`;
        if (downloadedRenderKeys.has(downloadKey)) {
          pendingRenderDownloadJobId = null;
          return;
        }
        downloadedRenderKeys.add(downloadKey);
        pendingRenderDownloadJobId = null;
        triggerBrowserDownload(
          fileUrl(state.jobId, state.output, { download: true }),
          baseName(state.output),
        );
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
          if (!current) return normalized;
          if (
            current.revision !== normalized.revision
            && projectShapeFingerprint(current) === projectShapeFingerprint(normalized)
          ) {
            return mergeRuntimeAssetState(current, normalized);
          }
          if (current.revision !== normalized.revision) return normalized;
          const previewByAssetId = new Map(
            normalized.assets.map((asset) => [asset.id, asset.preview ?? null]),
          );
          const backgroundRemovalByAssetId = new Map(
            normalized.assets.map((asset) => [asset.id, asset.background_removal ?? null]),
          );
          let changed = false;
          const mergedAssets = current.assets.map((asset) => {
            if (!previewByAssetId.has(asset.id)) return asset;
            const nextPreview = previewByAssetId.get(asset.id) ?? null;
            const nextBackgroundRemoval = backgroundRemovalByAssetId.get(asset.id) ?? null;
            if (
              JSON.stringify(asset.preview ?? null) === JSON.stringify(nextPreview)
              && JSON.stringify(asset.background_removal ?? null) === JSON.stringify(nextBackgroundRemoval)
            ) {
              return asset;
            }
            changed = true;
            return {
              ...asset,
              preview: nextPreview,
              background_removal: nextBackgroundRemoval,
            };
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
    [
      sidebarCollapsed()
        ? "0px 0px minmax(0, 1fr)"
        : `${browserWidth()}px ${PANEL_SPLITTER_WIDTH}px minmax(0, 1fr)`,
      activeToolSidebar() ? `1px ${JOB_TOOL_SIDEBAR_WIDTH}px` : "0px 0px",
    ].join(" ");
  const editorMainRows = () =>
    timelineHeight() === null
      ? `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px minmax(0, 1fr)`
      : `minmax(0, 1fr) ${TIMELINE_SPLITTER_HEIGHT}px ${timelineHeight()}px`;
  const onSidebarSegmentSelect = (view: SidebarView) => {
    if (!sidebarCollapsed() && sidebarView() === view) {
      setSidebarCollapsed(true);
      return;
    }
    setSidebarView(view);
    if (sidebarCollapsed()) setSidebarCollapsed(false);
  };
  const onToolSelect = (step: ToolStep) => {
    setActiveToolSidebar((current) => (current === step ? null : step));
  };
  const closeToolSidebar = () => setActiveToolSidebar(null);

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
          <div class="pipeline-bar-row">
            <PipelineBar
              assetCount={draftProject()?.assets.length ?? 0}
              logCount={(data()?.logs ?? []).length}
              sidebarOpen={!sidebarCollapsed()}
              sidebarView={sidebarView()}
              onSidebarSegmentSelect={onSidebarSegmentSelect}
              activeToolSidebar={activeToolSidebar()}
              onToolSelect={onToolSelect}
            />
          </div>
          <div class="editor-shell" style={{ "grid-template-columns": editorShellColumns() }}>
            <div class="browser-col" style={{ overflow: "hidden" }}>
              <AssetBrowserPanel project={draftProject} view={sidebarView} />
            </div>
            <div
              class="browser-resize-handle"
              style={{ visibility: sidebarCollapsed() ? "hidden" : "visible" }}
              onPointerDown={onBrowserResizeStart}
            />
            <div class="editor-main-wrap">
              <div ref={editorMainRef} class="editor-main" style={{ "grid-template-rows": editorMainRows() }}>
                <WorkspaceGrid project={draftProject} updateProject={updateProject} />
                <div class="workspace-vsplit" onPointerDown={onTimelineResizeStart} />
                <TimelinePanel project={draftProject} updateProject={updateProject} />
              </div>
            </div>
            <div
              class="job-tool-sidebar-divider"
              style={{ visibility: activeToolSidebar() ? "visible" : "hidden" }}
            />
            <div class="job-tool-sidebar-col">
              <StepConfigSidebar step={activeToolSidebar} job={data} onClose={closeToolSidebar} />
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

const AssetBrowserPanel: Component<{
  project: Accessor<EditorialProject | null>;
  view: Accessor<SidebarView>;
}> = (props) => {
  const job = useJobQuery(selectedJobId);
  const deleteAsset = useDeleteEditorialAssetMutation();
  const requestAssetPreviews = useRequestAssetPreviewsMutation();
  const uploadAsset = useUploadEditorialAssetMutation();
  const [filter, setFilter] = createSignal("");
  const [selectedAssetId, setSelectedAssetId] = createSignal<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = createSignal<string | null>(null);
  const [draggingAssetId, setDraggingAssetId] = createSignal<string | null>(null);
  const [deletingAssetId, setDeletingAssetId] = createSignal<string | null>(null);
  const [viewMode, setViewMode] = createSignal<"grid" | "list">("grid");
  const [thumbnails, setThumbnails] = createSignal<Map<string, string>>(new Map());
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

  createEffect(() => {
    const currentAssets = project()?.assets ?? [];
    const activeAssetIds = new Set(currentAssets.map((asset) => asset.id));
    setThumbnails((prev) => {
      const next = new Map(
        [...prev.entries()].filter(([assetId]) => activeAssetIds.has(assetId)),
      );
      return next.size === prev.size ? prev : next;
    });
    if (selectedAssetId() && !activeAssetIds.has(selectedAssetId()!)) {
      setSelectedAssetId(null);
    }
    if (previewAssetId() && !activeAssetIds.has(previewAssetId()!)) {
      setPreviewAssetId(null);
    }
  });

  createEffect(() => {
    const jobId = selectedJobId();
    if (!jobId) return;
    for (const asset of assets()) {
      if (asset.kind !== "video") continue;
      if (thumbnails().has(asset.id)) continue;
      const url = fileUrl(jobId, asset.path);
      extractVideoThumbnail(url).then((thumb) => {
        if (!thumb) return;
        setThumbnails((prev) => {
          const next = new Map(prev);
          next.set(asset.id, thumb);
          return next;
        });
      });
    }
  });

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

  const handleDeleteAsset = async (asset: ProjectAsset) => {
    const jobId = selectedJobId();
    const current = project();
    if (!jobId || !current || asset.origin !== "library") return;
    const timelineClipCount = current.clips.filter((clip) => clip.asset_id === asset.id).length;
    const confirmed = window.confirm(
      timelineClipCount > 0
        ? `Eliminare "${asset.label}" dalla libreria? Verranno rimosse ${timelineClipCount} clip dalla timeline e tutti gli artefatti associati.`
        : `Eliminare "${asset.label}" dalla libreria e tutti gli artefatti associati?`,
    );
    if (!confirmed) return;

    setDeletingAssetId(asset.id);
    try {
      await deleteAsset.mutateAsync({ jobId, assetId: asset.id });
      if (selectedAssetId() === asset.id) setSelectedAssetId(null);
      if (previewAssetId() === asset.id) setPreviewAssetId(null);
    } finally {
      setDeletingAssetId((currentAssetId) => (
        currentAssetId === asset.id ? null : currentAssetId
      ));
    }
  };

  return (
    <div class="panel asset-explorer">
      <div class="sidebar-tab-body" style={{ display: props.view() === "assets" ? "flex" : "none" }}>
        <div class="asset-browser-actions">
          <Button size="xs" onClick={() => inputRef?.click()}>
            Aggiungi asset
          </Button>
          <input
            ref={inputRef}
            type="file"
            class="asset-upload-input"
            accept="video/*,audio/*"
            multiple
            onChange={(e) => onFiles(e.currentTarget.files)}
          />
          <div class="asset-view-toggle">
            <button
              type="button"
              class={`asset-view-btn${viewMode() === "grid" ? " active" : ""}`}
              title="Vista griglia"
              onClick={() => setViewMode("grid")}
            >
              <IconLayoutGrid />
            </button>
            <button
              type="button"
              class={`asset-view-btn${viewMode() === "list" ? " active" : ""}`}
              title="Vista lista"
              onClick={() => setViewMode("list")}
            >
              <IconLayoutList />
            </button>
          </div>
        </div>
        <div class="asset-explorer-search">
          <IconSearch class="asset-search-icon" />
          <input
            type="text"
            class="asset-search-input"
            placeholder="Filtra asset..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <div class={`asset-explorer-content${viewMode() === "grid" ? " asset-explorer-content--grid" : ""}`}>
          <Show when={assets().length > 0} fallback={<div class="asset-explorer-empty"><span>Nessun asset disponibile</span></div>}>
            <Show
              when={viewMode() === "grid"}
              fallback={
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
                      <div class="asset-item-actions">
                        <button
                          type="button"
                          class={`asset-item-action${previewAssetId() === asset.id ? " active" : ""}`}
                          title={previewAssetId() === asset.id ? "Preview aperta" : "Apri preview"}
                          onClick={(e) => {
                            e.stopPropagation();
                            openAssetPreview(asset);
                          }}
                        >
                          <IconEye />
                        </button>
                        <Show when={asset.origin === "library"}>
                          <button
                            type="button"
                            class="asset-item-action asset-item-action--danger"
                            title="Elimina media"
                            aria-label="Elimina media"
                            disabled={deletingAssetId() === asset.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteAsset(asset);
                            }}
                          >
                            <IconTrash />
                          </button>
                        </Show>
                      </div>
                      <span class={`asset-item-badge asset-item-badge--${asset.kind}`}>{asset.kind.toUpperCase()}</span>
                    </div>
                  )}
                </For>
              }
            >
              <div class="asset-grid">
                <For each={assets()}>
                  {(asset) => (
                    <div
                      role="button"
                      tabIndex={0}
                      class={`asset-card${selectedAssetId() === asset.id || previewAsset()?.id === asset.id ? " active" : ""}${draggingAssetId() === asset.id ? " is-dragging" : ""}`}
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
                      onDblClick={() => openAssetPreview(asset)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedAssetId(asset.id);
                        }
                      }}
                    >
                      <div class="asset-card-thumb">
                        <Show
                          when={thumbnails().get(asset.id)}
                          fallback={
                            <div class="asset-card-thumb-placeholder">
                              <FileTypeIcon type={asset.kind} />
                            </div>
                          }
                        >
                          <img class="asset-card-thumb-img" src={thumbnails().get(asset.id)} alt="" draggable={false} />
                        </Show>
                        <span class={`asset-card-badge asset-item-badge--${asset.kind}`}>{asset.kind.toUpperCase()}</span>
                        <div class="asset-card-actions">
                          <button
                            type="button"
                            class={`asset-card-preview-btn${previewAssetId() === asset.id ? " active" : ""}`}
                            title={previewAssetId() === asset.id ? "Preview aperta" : "Apri preview"}
                            onClick={(e) => {
                              e.stopPropagation();
                              openAssetPreview(asset);
                            }}
                          >
                            <IconEye />
                          </button>
                          <Show when={asset.origin === "library"}>
                            <button
                              type="button"
                              class="asset-card-preview-btn asset-card-preview-btn--danger"
                              title="Elimina media"
                              aria-label="Elimina media"
                              disabled={deletingAssetId() === asset.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteAsset(asset);
                              }}
                            >
                              <IconTrash />
                            </button>
                          </Show>
                        </div>
                      </div>
                      <span class="asset-card-name">{asset.label || humanizeMediaName(asset.path)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
        <Show when={previewAsset()}>
          <div class="asset-preview-pane asset-preview-pane--fixed">
            <div class="asset-preview-header">
              <span class="asset-preview-title">{previewAsset()?.label || "Preview"}</span>
              <button type="button" class="asset-preview-close" title="Chiudi preview" onClick={closeAssetPreview}>
                <IconX />
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

      <div class="sidebar-tab-body sidebar-tab-body--logs" style={{ display: props.view() === "logs" ? "flex" : "none" }}>
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
  <Show
    when={props.type === "video"}
    fallback={<IconWaveSquare class={`asset-type-icon asset-type-icon--${props.type}`} />}
  >
    <IconVideo class={`asset-type-icon asset-type-icon--${props.type}`} />
  </Show>
);

const MonitorPanel: Component<{ project: Accessor<EditorialProject | null> }> = (props) => {
  const [gpuStatus, setGpuStatus] = createSignal<"ready" | "unsupported">("unsupported");
  const [codecStatus, setCodecStatus] = createSignal<"ready" | "unsupported">("unsupported");
  const [debugSidebarOpen, setDebugSidebarOpen] = createSignal(true);
  const [debugSidebarWidth, setDebugSidebarWidth] = createSignal(MIN_MONITOR_DEBUG_WIDTH);
  const [stageSize, setStageSize] = createSignal({ width: 0, height: 0 });
  const [transportPlaying, setTransportPlaying] = createSignal(false);
  const [monitorDiagnostics, setMonitorDiagnostics] = createSignal<MonitorDiagnostics>({
    renderer: "webgpu",
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
    lastError: null,
  });
  let stageRef: HTMLDivElement | undefined;
  let canvasRef: HTMLCanvasElement | undefined;
  let runtime: CanvasMonitorRuntime | null = null;
  const [runtimeReady, setRuntimeReady] = createSignal(false);
  let rangeLoopSeekInFlight = false;
  let compositionSyncToken = 0;

  const project = () => props.project();
  const composition = createMemo(() => (project() ? compileMonitorComposition(project()!) : null));
  const compositionSyncKey = createMemo(() => monitorCompositionSyncKey(composition()));
  const frameRate = createMemo(() => Math.max(1, composition()?.sequence.fps ?? 30));
  const monitorDuration = createMemo(() => Math.max(0, composition()?.duration ?? 0));
  const sequenceWidth = createMemo(() => Math.max(1, Math.round(composition()?.sequence.width ?? 1080)));
  const sequenceHeight = createMemo(() => Math.max(1, Math.round(composition()?.sequence.height ?? 1920)));
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
  const monitorPlayhead = createMemo(() => Math.max(0, Math.min(playheadTime(), monitorDuration())));
  const monitorHasMedia = createMemo(() => monitorDuration() > 0);
  const monitorProgressPercent = createMemo(() =>
    monitorDuration() > 0 ? (monitorPlayhead() / monitorDuration()) * 100 : 0
  );
  const timelineRange = createMemo(() => {
    const current = timelineRangeSelection();
    if (!current) return null;
    const start = Math.min(current.start, current.end);
    const end = Math.max(current.start, current.end);
    return end - start >= 0.02 ? { start, end, duration: end - start } : null;
  });
  const monitorUnsupported = createMemo(() => gpuStatus() === "unsupported" || codecStatus() === "unsupported");
  const monitorBrowserCapabilities = createMemo(() => {
    const browserWindow = typeof window !== "undefined"
      ? window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }
      : null;
    const capabilityStatus = (supported: boolean): "ready" | "unsupported" => (
      supported ? "ready" : "unsupported"
    );
    return [
      { label: "webgpu", status: gpuStatus() },
      { label: "webcodecs", status: codecStatus() },
      { label: "video decoder", status: capabilityStatus(!!browserWindow && "VideoDecoder" in browserWindow) },
      { label: "audio decoder", status: capabilityStatus(!!browserWindow && "AudioDecoder" in browserWindow) },
      { label: "audio context", status: capabilityStatus(!!browserWindow && ("AudioContext" in browserWindow || "webkitAudioContext" in browserWindow)) },
      { label: "worker", status: capabilityStatus(typeof Worker !== "undefined") },
      { label: "resize observer", status: capabilityStatus(typeof ResizeObserver !== "undefined") },
      { label: "video frame", status: capabilityStatus(!!browserWindow && "VideoFrame" in browserWindow) },
    ];
  });
  const monitorDiagnosticsJson = createMemo(() => JSON.stringify(monitorDiagnostics(), null, 2));
  const clampMonitorDebugWidth = (width: number) =>
    Math.max(MIN_MONITOR_DEBUG_WIDTH, Math.min(MAX_MONITOR_DEBUG_WIDTH, Math.round(width)));

  const resolveMonitorMediaUrl = (path: string) => {
    const jobId = selectedJobId();
    return jobId ? fileUrl(jobId, path) : null;
  };

  const togglePlayback = () => {
    if (!runtime || !monitorHasMedia()) return;
    void (transportPlaying() ? runtime.pause() : runtime.play());
  };
  const adjacentFrameTime = (direction: -1 | 1, maxTime = Number.POSITIVE_INFINITY) => {
    const fps = frameRate();
    const current = Math.max(0, Math.min(maxTime, playheadTime()));
    const framePosition = current * fps;
    const nextFrame = direction > 0
      ? Math.floor(framePosition + FRAME_STEP_EPSILON) + 1
      : Math.ceil(framePosition - FRAME_STEP_EPSILON) - 1;
    return Math.max(0, Math.min(maxTime, nextFrame / fps));
  };
  const stepFrame = (direction: -1 | 1) => {
    if (!runtime) return;
    void (async () => {
      await runtime.pause();
      await runtime.seek(adjacentFrameTime(direction, monitorDuration()));
    })();
  };
  const scrubMonitor = (time: number) => {
    if (!runtime) return;
    void runtime.seek(Math.max(0, Math.min(monitorDuration(), time)));
  };
  const onMonitorDebugResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = debugSidebarWidth();
    const onMove = (ev: PointerEvent) => {
      setDebugSidebarWidth(clampMonitorDebugWidth(startWidth + ev.clientX - startX));
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

  const syncRuntimeComposition = (currentComposition: ReturnType<typeof composition>) => {
    if (!runtime) return;
    const syncToken = ++compositionSyncToken;
    const targetTime = currentComposition
      ? Math.max(0, Math.min(currentComposition.duration, untrack(playheadTime)))
      : 0;
    void (async () => {
      await runtime?.setComposition(currentComposition, resolveMonitorMediaUrl);
      if (
        syncToken !== compositionSyncToken
        || !runtime
        || !currentComposition
      ) {
        return;
      }
      if (!runtime.isPlaying()) {
        await runtime.seek(targetTime);
      }
    })();
  };

  createEffect(() => {
    sequenceWidth();
    sequenceHeight();
    if (canvasRef) {
      canvasRef.width = sequenceWidth();
      canvasRef.height = sequenceHeight();
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
    if (!canvasRef || runtimeReady()) return;
    runtime = new CanvasMonitorRuntime(canvasRef, {
      onTimeUpdate: (time) => {
        const range = timelineRange();
        if (
          runtime
          && transportPlaying()
          && timelineRangeLoopEnabled()
          && range
          && time >= range.end - FRAME_STEP_EPSILON
          && !rangeLoopSeekInFlight
        ) {
          rangeLoopSeekInFlight = true;
          setPlayheadTime(range.start);
          void runtime.seek(range.start).finally(() => {
            rangeLoopSeekInFlight = false;
          });
          return;
        }
        setPlayheadTime(time);
      },
      onPlayingChange: (playing) => setTransportPlaying(playing),
      onGpuStatus: setGpuStatus,
      onCodecStatus: setCodecStatus,
      onDiagnostics: setMonitorDiagnostics,
      onError: (error) => {
        console.error("[monitor-runtime]", error);
      },
    });
    setRuntimeReady(true);
  });

  createEffect(() => {
    const currentJobId = selectedJobId();
    const currentCompositionKey = compositionSyncKey();
    if (!runtimeReady() || !runtime) return;
    void currentJobId;
    void currentCompositionKey;
    syncRuntimeComposition(composition());
  });

  createEffect(
    on(seekRequest, (time) => {
      if (time === null) return;
      setSeekRequest(null);
      if (!runtime) return;
      void runtime.seek(time);
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
      if (runtime) {
        void (async () => {
          await runtime.pause();
          await runtime.seek(adjacentFrameTime(dir > 0 ? 1 : -1));
        })();
      }
      setFrameStepRequest(0);
    }),
  );
  onCleanup(() => {
    void runtime?.destroy();
    runtime = null;
  });

  return (
    <div class="panel monitor-panel">
      <div class="panel-header">
        <button
          type="button"
          class={`monitor-header-btn${debugSidebarOpen() ? " active" : ""}`}
          title={
            monitorUnsupported()
              ? "Diagnostica non disponibile"
              : debugSidebarOpen()
                ? "Nascondi diagnostica"
                : "Mostra diagnostica"
          }
          aria-label={
            monitorUnsupported()
              ? "Diagnostica non disponibile"
              : debugSidebarOpen()
                ? "Nascondi diagnostica"
                : "Mostra diagnostica"
          }
          aria-pressed={debugSidebarOpen()}
          disabled={monitorUnsupported()}
          onClick={() => setDebugSidebarOpen((value) => !value)}
        >
          <Show when={debugSidebarOpen()} fallback={<IconLayoutSidebarLeftExpand />}>
            <IconLayoutSidebarLeftCollapse />
          </Show>
        </button>
        <span class="panel-title">Monitor</span>
      </div>
      <div class="monitor-workbench">
        <Show when={!monitorUnsupported() && debugSidebarOpen()}>
          <aside
            class="monitor-debug-shell"
            style={{
              width: `${debugSidebarWidth()}px`,
              "flex-basis": `${debugSidebarWidth()}px`,
            }}
          >
            <div class="monitor-debug-panel">
              <div class="monitor-debug-section">
                <div class="monitor-debug-title">runtime</div>
                <InfoRow variant="debug" label="renderer" value={monitorDiagnostics().renderer} />
                <InfoRow variant="debug" label="playing" value={monitorDiagnostics().runtime.playing ? "yes" : "no"} />
                <InfoRow variant="debug" label="initialized" value={monitorDiagnostics().runtime.initialized ? "yes" : "no"} />
                <InfoRow variant="debug" label="raf / queued / render">
                  <strong>
                    {monitorDiagnostics().runtime.rafActive ? "1" : "0"}
                    {" / "}
                    {monitorDiagnostics().runtime.renderQueued ? "1" : "0"}
                    {" / "}
                    {monitorDiagnostics().runtime.rendering ? "1" : "0"}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="clock" value={fmtTimePrecise(monitorDiagnostics().currentTime)} />
                <InfoRow variant="debug" label="layers" value={`${monitorDiagnostics().renderedLayers}/${monitorDiagnostics().activeLayers}`} />
                <InfoRow variant="debug" label="decoded since seek" value={monitorDiagnostics().decodedFrames} />
                <InfoRow variant="debug" label="buffered" value={monitorDiagnostics().bufferedFrames} />
                <InfoRow variant="debug" label="pending render">
                  <strong>
                    {formatMonitorDebugTime(monitorDiagnostics().runtime.pendingRenderTime)}
                    {" / "}
                    {monitorDiagnostics().runtime.pendingRenderBlocking === null
                      ? "—"
                      : monitorDiagnostics().runtime.pendingRenderBlocking ? "blocking" : "async"}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="last req">
                  <strong>
                    {formatMonitorDebugTime(monitorDiagnostics().runtime.lastRenderRequestTime)}
                    {" / "}
                    {monitorDiagnostics().runtime.lastRenderRequestBlocking === null
                      ? "—"
                      : monitorDiagnostics().runtime.lastRenderRequestBlocking ? "blocking" : "async"}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="last done">
                  <strong>
                    {formatMonitorDebugTime(monitorDiagnostics().runtime.lastCompletedRenderTime)}
                    {" / "}
                    {monitorDiagnostics().runtime.lastCompletedRenderBlocking === null
                      ? "—"
                      : monitorDiagnostics().runtime.lastCompletedRenderBlocking ? "blocking" : "async"}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="players ready" value={`${monitorDiagnostics().runtime.readyVideoPlayers}/${monitorDiagnostics().runtime.videoPlayerEntries}`} />
                <InfoRow variant="debug" label="cache demux/audio" value={`${monitorDiagnostics().runtime.demuxCacheEntries} / ${monitorDiagnostics().runtime.audioBufferCacheEntries}`} />
                <div class="monitor-debug-kv">
                  <span>revision</span>
                  <code>{monitorDiagnostics().runtime.compositionRevisionKey ?? "—"}</code>
                </div>
              </div>
              <div class="monitor-debug-section">
                <div class="monitor-debug-title">audio</div>
                <InfoRow variant="debug" label="state">
                  <strong>
                    {monitorDiagnostics().audio.playing ? "playing" : "paused"}
                    {" / "}
                    {monitorDiagnostics().audio.contextState}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="ctx time">
                  <strong>
                    {(() => {
                      const currentTime = monitorDiagnostics().audio.contextCurrentTime;
                      return currentTime === null ? "—" : `${currentTime.toFixed(3)}s`;
                    })()}
                  </strong>
                </InfoRow>
                <InfoRow variant="debug" label="start ctx" value={`${monitorDiagnostics().audio.startContextTime.toFixed(3)}s`} />
                <InfoRow variant="debug" label="start tl" value={fmtTimePrecise(monitorDiagnostics().audio.startTimelineTime)} />
                <InfoRow variant="debug" label="scheduled nodes" value={monitorDiagnostics().audio.scheduledNodeCount} />
                <InfoRow variant="debug" label="sample rate" value={monitorDiagnostics().audio.sampleRate ?? "—"} />
              </div>
              <Show when={monitorDiagnostics().layers.length > 0}>
                <div class="monitor-debug-section">
                  <div class="monitor-debug-title">layers</div>
                  <For each={monitorDiagnostics().layers}>
                    {(layer) => (
                      <div class="monitor-debug-card">
                        <InfoRow variant="debug" label={layer.clipId} value={layer.includedInRender ? "render" : "skip"} />
                        <InfoRow variant="debug" label="target / frame">
                          <strong>
                            {formatMonitorDebugUs(layer.localTimeUs)}
                            {" / "}
                            {formatMonitorDebugUs(layer.frameTimestampUs)}
                          </strong>
                        </InfoRow>
                        <InfoRow variant="debug" label="worker / accel" value={`${layer.player?.workerReady ? "ready" : "boot"} / ${layer.player?.selectedAcceleration ?? "—"}`} />
                        <InfoRow variant="debug" label="cache">
                          <strong>
                            {layer.player?.bufferedFrames ?? 0}
                            {" @ "}
                            {formatMonitorDebugUs(layer.player?.bufferedRangeStartUs ?? null)}
                            {".."}
                            {formatMonitorDebugUs(layer.player?.bufferedRangeEndUs ?? null)}
                          </strong>
                        </InfoRow>
                        <InfoRow variant="debug" label="dispatch">
                          <strong>
                            {formatMonitorDebugUs(layer.player?.lastDispatchedTargetUs ?? null)}
                            {" / "}
                            {layer.player?.lastDispatchedPlaying === null
                              ? "—"
                              : layer.player?.lastDispatchedPlaying ? "play" : "pause"}
                          </strong>
                        </InfoRow>
                        <InfoRow variant="debug" label="request">
                          <strong>
                            {formatMonitorDebugUs(layer.player?.lastRequestedTargetUs ?? null)}
                            {" / "}
                            {layer.player?.lastForceSeek ? "seek" : "keep"}
                          </strong>
                        </InfoRow>
                        <InfoRow variant="debug" label="intent / session">
                          <strong>
                            {layer.player?.lastRequestedIntent ?? "—"}
                            {" / "}
                            {layer.player?.activeSessionToken ?? 0}
                            {layer.player?.pendingSessionToken ? `>${layer.player.pendingSessionToken}` : ""}
                          </strong>
                        </InfoRow>
                        <InfoRow variant="debug" label="had frame / resume seek" value={`${layer.player?.lastHadFrameAtTarget ? "yes" : "no"} / ${layer.player?.lastResumeRequiresSeek ? "yes" : "no"}`} />
                        <Show when={layer.player?.lastError}>
                          <div class="monitor-debug-kv">
                            <span>player error</span>
                            <code>{layer.player?.lastError}</code>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={monitorDiagnostics().events.length > 0}>
                <div class="monitor-debug-section">
                  <div class="monitor-debug-title">events</div>
                  <div class="monitor-debug-log">
                    <For each={monitorDiagnostics().events.slice().reverse()}>
                      {(event) => (
                        <div class="monitor-debug-log-line">
                          <span>[{(event.atMs / 1000).toFixed(3)}]</span>
                          <strong>{event.scope}</strong>
                          <span>{event.message}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
              <div class="monitor-debug-section">
                <div class="monitor-debug-title">snapshot</div>
                <pre class="monitor-debug-json">{monitorDiagnosticsJson()}</pre>
              </div>
              <div class="monitor-debug-section">
                <div class="monitor-debug-title">browser</div>
                <For each={monitorBrowserCapabilities()}>
                  {(entry) => (
                    <InfoRow variant="debug" label={entry.label}>
                      <span class={`monitor-debug-status monitor-debug-status--${entry.status}`}>{entry.status}</span>
                    </InfoRow>
                  )}
                </For>
              </div>
              <Show when={monitorDiagnostics().lastError}>
                <div class="monitor-debug-section monitor-debug-section--error">
                  <div class="monitor-debug-title">error</div>
                  <div class="monitor-debug-panel__error">{monitorDiagnostics().lastError}</div>
                </div>
              </Show>
            </div>
          </aside>
          <div
            class="monitor-debug-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Ridimensiona diagnostica monitor"
            onPointerDown={onMonitorDebugResizeStart}
          />
        </Show>
        <div class="monitor-main-col">
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
                class="monitor-canvas active"
                width={sequenceWidth()}
                height={sequenceHeight()}
              />
              <Show when={monitorUnsupported()}>
                <div class="monitor-stage-overlay">
                  <div class="monitor-stage-overlay-card">
                    <div class="monitor-stage-overlay-title">Monitor non supportato</div>
                    <div class="monitor-stage-overlay-copy">
                      Il monitor realtime richiede Chromium con WebGPU e WebCodecs attivi.
                    </div>
                  </div>
                </div>
              </Show>
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
                    <IconPlayerSkipBack aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="monitor-control-btn"
                    title="Frame precedente"
                    aria-label="Frame precedente"
                    disabled={!monitorHasMedia()}
                    onClick={() => stepFrame(-1)}
                  >
                    <IconPlayerTrackPrev aria-hidden="true" />
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
                        <IconPlayerPlay aria-hidden="true" />
                      }
                    >
                      <IconPlayerPause aria-hidden="true" />
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
                    <IconPlayerTrackNext aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="monitor-control-btn"
                    title="Vai alla fine"
                    aria-label="Vai alla fine"
                    disabled={!monitorHasMedia()}
                    onClick={() => scrubMonitor(monitorDuration())}
                  >
                    <IconPlayerSkipForward aria-hidden="true" />
                  </button>
                </div>
                <div class="monitor-timecodes monitor-timecodes--right" aria-live="off">
                  <span class="monitor-timecode monitor-timecode--total">{fmtTimePrecise(monitorDuration())}</span>
                </div>
              </div>
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
  const requestedPreviewKeys = new Set<string>();
  const [dragPreview, setDragPreview] = createSignal<{
    assetId: string;
    start: number;
    label: string;
    duration: number;
    trackIds: string[];
  } | null>(null);
  const [editingSubtitleId, setEditingSubtitleId] = createSignal<string | null>(null);
  const [editingSubtitleText, setEditingSubtitleText] = createSignal("");
  const [timelineTool, setTimelineTool] = createSignal<TimelineTool>("select");
  const [editorialLaneVisible, setEditorialLaneVisible] = createSignal(false);
  const project = () => props.project();
  const projectFrameRate = createMemo(() => Math.max(1, project()?.sequence.fps ?? 30));
  const [zoomIdx, setZoomIdx] = createSignal(DEFAULT_ZOOM_INDEX);
  const zoom = () => ZOOM_STEPS[zoomIdx()];
  const pxPerSecond = () => BASE_PX_PER_SEC * zoom();
  const [viewportLeft, setViewportLeft] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(1);
  const [hoverOffset, setHoverOffset] = createSignal<number | null>(null);
  let zoomWheelAccumulator = 0;
  let zoomWheelResetHandle: ReturnType<typeof setTimeout> | undefined;
  let rulerViewportRef: HTMLDivElement | undefined;
  let rulerInnerRef: HTMLDivElement | undefined;
  let assetViewportRef: HTMLDivElement | undefined;
  let editorialViewportRef: HTMLDivElement | undefined;
  let audioViewportRef: HTMLDivElement | undefined;
  let assetLabelsRef: HTMLDivElement | undefined;
  let editorialLabelsRef: HTMLDivElement | undefined;
  let audioLabelsRef: HTMLDivElement | undefined;
  let assetInnerRef: HTMLDivElement | undefined;
  let editorialInnerRef: HTMLDivElement | undefined;
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
  const hoverTime = createMemo(() => {
    const offset = hoverOffset();
    return offset === null ? null : pxToSec(viewportLeft() + offset);
  });
  const tracks = createMemo(() => (project() ? sortedTracks(project()!) : []));
  const videoTracks = createMemo(() => tracks().filter((track) => track.kind === "video"));
  const editorialTrack = createMemo(() => tracks().find((track) => track.kind === "subtitle") ?? null);
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
  const runningSubtitleClipIds = createMemo(() => new Set(
    (project()?.clips ?? [])
      .filter((clip) => clip.transcription_status === "running")
      .map((clip) => clip.id),
  ));
  const pendingSubtitleRanges = createMemo(() => {
    const current = project();
    if (!current) return [];
    const lanePending = current.lane_transcriptions.flatMap((lane) => {
      if (lane.status !== "running") return [];
      const range = laneContentRange(current, lane.lane_id);
      if (!range || range.end <= range.start) return [];
      const sourceTrack = getTrack(current, lane.lane_id);
      return [{
        id: `subtitle_pending_${lane.lane_id}`,
        trackId: lane.lane_id,
        clipId: null,
        start: range.start,
        end: range.end,
        label: sourceTrack ? `AI TRANSCRIPTION / ${sourceTrack.name}` : "AI TRANSCRIPTION",
      }];
    });
    const clipPending = current.clips.flatMap((clip) => {
      const track = getTrack(current, clip.track_id);
      if (!track || track.kind !== "audio" || !clip.enabled || clip.transcription_status !== "running") {
        return [];
      }
      const asset = assetById(current, clip.asset_id);
      return [{
        id: `subtitle_pending_${clip.id}`,
        trackId: clip.track_id,
        clipId: clip.id,
        start: clip.start,
        end: clip.start + (clip.source_out - clip.source_in),
        label: asset ? `AI TRANSCRIPTION / ${asset.label}` : "AI TRANSCRIPTION",
      }];
    });
    return [...lanePending, ...clipPending];
  });
  const visibleStandaloneSubtitles = (trackId: string) =>
    trackSubtitles(project()!, trackId).filter((caption) => (
      caption.origin !== "generated" || isEditorialResultCaption(caption)
    ));
  const pendingTrackSubtitleRanges = (trackId: string) =>
    pendingSubtitleRanges().filter((item) => item.trackId === trackId);
  const generatedTrackSubtitleGroups = (trackId: string) =>
    runningSubtitleLaneIds().has(trackId)
      ? []
      : generatedSubtitleGroupsForLane(project()!, trackId).filter((group) => (
          !group.sourceClipId || !runningSubtitleClipIds().has(group.sourceClipId)
        ));
  const editorialDecisionSegmentClass = (caption: SubtitleBlock) => {
    const label = editorialDecisionLabel(caption);
    return label ? `tl-seg--word ${label}` : undefined;
  };
  const renderedTrackHeight = (track: TimelineTrack) => (
    track.kind === "subtitle" ? EDITORIAL_STANDALONE_HEIGHT : trackHeight(track.kind)
  );
  const timelineViewportForTrack = (track: TimelineTrack) => {
    if (track.kind === "audio") return audioViewportRef;
    if (track.kind === "subtitle") return editorialViewportRef;
    return assetViewportRef;
  };
  const cancelSubtitleEditing = () => {
    setEditingSubtitleId(null);
    setEditingSubtitleText("");
  };
  const selectTrack = (trackId: string) => {
    setSelectedTrackId(trackId);
    setSelectedClipId(null);
    setSelectedSubtitleId(null);
    cancelSubtitleEditing();
  };
  const selectSubtitle = (caption: SubtitleBlock, trackId: string) => {
    setSelectedSubtitleId(caption.id);
    setSelectedTrackId(trackId);
    setSelectedClipId(null);
    if (editingSubtitleId() && editingSubtitleId() !== caption.id) cancelSubtitleEditing();
  };
  const beginSubtitleEditing = (caption: SubtitleBlock, trackId: string) => {
    selectSubtitle(caption, trackId);
    setEditingSubtitleId(caption.id);
    setEditingSubtitleText(caption.text);
  };
  const commitSubtitleEditing = () => {
    const current = project();
    const subtitleId = editingSubtitleId();
    if (!current || !subtitleId) {
      cancelSubtitleEditing();
      return;
    }
    const target = getSubtitleBlock(current, subtitleId);
    const nextText = editingSubtitleText().trim();
    if (!target || !nextText || nextText === target.text) {
      cancelSubtitleEditing();
      return;
    }
    props.updateProject((value) => patchSubtitle(value, subtitleId, { text: nextText }));
    cancelSubtitleEditing();
  };
  const updateTrack = (trackId: string, patch: Partial<TimelineTrack>) => {
    props.updateProject((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (
        track.id === trackId ? { ...track, ...patch } : track
      )),
    }));
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
    const targetMinorStep = RULER_MINOR_STEPS.find((step) => step * pxPerSecond() >= RULER_MINOR_TARGET_PX)
      ?? RULER_MINOR_STEPS[RULER_MINOR_STEPS.length - 1];
    const fps = projectFrameRate();
    const minorFrames = Math.max(1, Math.ceil(targetMinorStep * fps - Number.EPSILON));
    return {
      minorFrames,
      minorStep: minorFrames / fps,
      labelStep: (minorFrames * RULER_LABEL_EVERY_N_TICKS) / fps,
    };
  });
  const rulerTicks = createMemo(() => {
    const ticks: Array<{ time: number; kind: "major" | "medium" | "minor"; label: string | null }> = [];
    const fps = projectFrameRate();
    const { minorFrames, labelStep } = rulerScale();
    const count = Math.ceil((duration() * fps) / minorFrames);
    for (let index = 0; index <= count; index += 1) {
      const time = Number((((index * minorFrames) / fps)).toFixed(6));
      const isLabel = index % RULER_LABEL_EVERY_N_TICKS === 0;
      const isMedium = !isLabel && index % (RULER_LABEL_EVERY_N_TICKS / 2) === 0;
      const kind: "major" | "medium" | "minor" = isLabel ? "major" : isMedium ? "medium" : "minor";
      ticks.push({
        time,
        kind,
        label: isLabel ? formatRulerLabel(time, labelStep) : null,
      });
    }
    return ticks;
  });
  const selectedClip = createMemo(() => project() ? getClip(project()!, selectedClipId()) : null);
  const selectedLinkedGroupId = createMemo(() => selectedClip()?.linked_group_id ?? null);
  const selectedSubtitle = createMemo(() =>
    project() ? getSubtitleBlock(project()!, selectedSubtitleId()) : null
  );
  const timelineRange = createMemo(() => {
    const current = timelineRangeSelection();
    if (!current) return null;
    const start = Math.min(current.start, current.end);
    const end = Math.max(current.start, current.end);
    return end - start >= 0.02 ? { start, end, duration: end - start } : null;
  });
  const timelineToolClassName = createMemo(() => timelineTool().replace(/_/g, "-"));
  const clearTimelineRange = () => setTimelineRangeSelection(null);
  const toggleTimelineTool = (tool: TimelineTool) => {
    setTimelineTool((current) => (current === tool ? "select" : tool));
  };
  const toggleTimelineRangeLoop = () => {
    const range = timelineRange();
    if (!range) return;
    const next = !timelineRangeLoopEnabled();
    setTimelineRangeLoopEnabled(next);
    if (next && (playheadTime() < range.start || playheadTime() > range.end)) {
      setSeekRequest(range.start);
    }
  };
  const selectClip = (clip: TimelineClip, trackId: string) => {
    setSelectedClipId(clip.id);
    setSelectedTrackId(trackId);
    setSelectedSubtitleId(null);
  };
  const applyRippleDeleteToSelectedRange = () => {
    const range = timelineRange();
    if (!range) return false;
    props.updateProject((current) => rippleDeleteRange(current, range.start, range.end));
    clearTimelineRange();
    setSelectedClipId(null);
    setSelectedSubtitleId(null);
    return true;
  };
  const shouldApplyRippleRangeAtPointer = (clientX: number) => {
    if (timelineTool() !== "ripple_delete") return false;
    const range = timelineRange();
    if (!range) return false;
    const time = getTimeFromPointer(clientX);
    return time >= range.start && time <= range.end;
  };
  const applyTimelineToolToClip = (event: MouseEvent, clip: TimelineClip, track: TimelineTrack) => {
    const tool = timelineTool();
    if (tool === "select" || tool === "range" || tool === "trim" || tool === "slip") return false;
    if (tool === "disable" && !clip.enabled) return false;
    if (tool === "enable" && clip.enabled) return false;
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip, track.id);
    if (tool === "cut") {
      const splitTime = getTimeFromPointer(event.clientX);
      props.updateProject((current) => splitClip(current, clip.id, splitTime));
      return true;
    }
    if (tool === "delete") {
      props.updateProject((current) => removeClip(current, clip.id));
      setSelectedClipId(null);
      setSelectedSubtitleId(null);
      setSelectedTrackId(track.id);
      return true;
    }
    if (tool === "ripple_delete") {
      props.updateProject((current) => rippleDeleteClip(current, clip.id));
      setSelectedClipId(null);
      setSelectedSubtitleId(null);
      setSelectedTrackId(track.id);
      return true;
    }
    props.updateProject((current) => setClipEnabled(current, clip.id, tool === "enable"));
    return true;
  };
  const overviewClips = createMemo(() => {
    const current = project();
    if (!current) return [] as Array<{
      id: string;
      kind: "video" | "audio";
      start: number;
      end: number;
    }>;

    const grouped = new Map<string, TimelineClip[]>();
    const standalone: Array<{
      id: string;
      kind: "video" | "audio";
      start: number;
      end: number;
    }> = [];

    for (const clip of current.clips) {
      const track = getTrack(current, clip.track_id);
      if (!track || (track.kind !== "video" && track.kind !== "audio")) continue;
      if (!clip.linked_group_id) {
        standalone.push({
          id: clip.id,
          kind: track.kind,
          start: clip.start,
          end: clip.start + (clip.source_out - clip.source_in),
        });
        continue;
      }
      const group = grouped.get(clip.linked_group_id) ?? [];
      group.push(clip);
      grouped.set(clip.linked_group_id, group);
    }

    const linked = [...grouped.entries()].map(([groupId, clips]) => {
      const kinds = clips.map((clip) => getTrack(current, clip.track_id)?.kind).filter((kind) => (
        kind === "video" || kind === "audio"
      ));
      return {
        id: groupId,
        kind: kinds.includes("video") ? "video" as const : "audio" as const,
        start: Math.min(...clips.map((clip) => clip.start)),
        end: Math.max(...clips.map((clip) => clip.start + (clip.source_out - clip.source_in))),
      };
    });

    return [...standalone, ...linked].sort((a, b) => (a.start - b.start) || a.id.localeCompare(b.id));
  });
  const overviewSubtitles = createMemo(() =>
    project()
      ? visibleTimelineCaptions(project()!).filter((caption) => !caption.source_clip_id)
      : []
  );
  createEffect(() => {
    const current = project();
    const editingId = editingSubtitleId();
    if (!editingId) return;
    if (!current || !getSubtitleBlock(current, editingId)) cancelSubtitleEditing();
  });
  createEffect(
    on(selectedSubtitleId, (subtitleId) => {
      const editingId = editingSubtitleId();
      if (editingId && subtitleId !== editingId) cancelSubtitleEditing();
    }),
  );
  createEffect(() => {
    if (!timelineRange()) {
      setTimelineRangeLoopEnabled(false);
    }
  });
  const visiblePreviewState = createMemo(() => {
    const current = project();
    if (!current) return { requests: [] as Array<{ assetId: string; key: string }>, hasGenerating: false };
    const visibleStart = viewportLeft();
    const visibleEnd = visibleStart + viewportWidth();
    const nextRequests = new Map<string, string>();
    let hasGenerating = false;

    for (const track of [...videoTracks(), ...audioTracks()]) {
      const previewKind = track.kind === "audio" ? "audio" : "video";
      for (const clip of trackClips(current, track.id)) {
        const clipWidth = Math.max(8, (clip.source_out - clip.source_in) * pxPerSecond());
        if (clipWidth < CLIP_PREVIEW_MIN_WIDTH_PX) continue;
        const clipLeft = toPx(clip.start);
        const clipRight = clipLeft + clipWidth;
        if (clipRight < visibleStart || clipLeft > visibleEnd) continue;
        const asset = assetById(current, clip.asset_id);
        if (!asset) continue;
        if (shouldRequestClipPreview(asset, previewKind)) {
          const key = previewRequestKey(asset, previewKind);
          if (key) nextRequests.set(key, asset.id);
        }
        if (hasGeneratingClipPreview(asset, previewKind)) hasGenerating = true;
        if (track.kind === "video" && clip.mask_enabled) {
          if (shouldRequestClipPreview(asset, "video", "mask")) {
            const key = previewRequestKey(asset, "video", "mask");
            if (key) nextRequests.set(key, asset.id);
          }
          if (hasGeneratingClipPreview(asset, "video", "mask")) hasGenerating = true;
        }
      }
    }

    return {
      requests: [...nextRequests.entries()].map(([key, assetId]) => ({ assetId, key })),
      hasGenerating,
    };
  });
  const horizontalViewports = () =>
    [rulerViewportRef, assetViewportRef, editorialViewportRef, audioViewportRef]
      .filter(Boolean) as HTMLDivElement[];
  const syncViewportMetrics = (source?: HTMLDivElement) => {
    const viewport = source ?? rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
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
    const rect = (rulerInnerRef ?? assetInnerRef ?? editorialInnerRef ?? audioInnerRef)?.getBoundingClientRect();
    if (!rect) return 0;
    return pxToSec(clientX - rect.left);
  };
  const updateTimelineHover = (event: PointerEvent) => {
    const viewport = (event.target as Element | null)?.closest(".timeline-ruler-viewport, .timeline-viewport");
    if (!(viewport instanceof HTMLDivElement)) {
      setHoverOffset(null);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const nextOffset = Math.max(0, Math.min(viewport.clientWidth, event.clientX - rect.left));
    setHoverOffset(nextOffset);
  };
  const trackGroupOffset = (kind: "video" | "audio") => {
    const inner = kind === "audio" ? audioInnerRef : assetInnerRef;
    const trackList = kind === "audio" ? audioTracks() : videoTracks();
    if (!inner || !trackList.length || kind === "audio") return 0;
    const totalHeight = trackList.reduce((sum, track) => sum + renderedTrackHeight(track), 0);
    return Math.max(0, inner.clientHeight - totalHeight);
  };
  const getTrackFromPointerY = (
    clientY: number,
    kind: "video" | "audio",
  ) => {
    const inner = kind === "audio" ? audioInnerRef : assetInnerRef;
    const trackList = kind === "audio" ? audioTracks() : videoTracks();
    const rect = inner?.getBoundingClientRect();
    if (!rect || clientY < rect.top || clientY > rect.bottom) return null;
    const pointerY = clientY - rect.top;
    let cursor = trackGroupOffset(kind);
    const rows = trackList.map((track) => {
      const top = cursor;
      cursor += renderedTrackHeight(track);
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
    const viewport = rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
    const nextPxPerSecond = BASE_PX_PER_SEC * ZOOM_STEPS[clamped];
    const anchorOffset = viewport && anchorClientX !== undefined
      ? anchorClientX - viewport.getBoundingClientRect().left
      : null;
    const anchorTime = viewport && anchorOffset !== null
      ? pxToSec(viewport.scrollLeft + anchorOffset)
      : null;
    setZoomIdx(clamped);
    requestAnimationFrame(() => {
      const nextViewport = rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
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
    const viewport = rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
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
    if (!rulerViewportRef && !assetViewportRef && !editorialViewportRef && !audioViewportRef) return;
    const target = event.currentTarget as HTMLDivElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const nextTime = duration() * frac;
    centerViewportAtTime(nextTime);
  };
  const beginMinimapViewportDrag = (event: PointerEvent) => {
    if (!rulerViewportRef && !assetViewportRef && !editorialViewportRef && !audioViewportRef) return;
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
      const viewport = rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
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

  const beginTrackViewportPan = (event: PointerEvent, track: TimelineTrack) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    if (timelineTool() === "range") {
      beginTimelineRangeSelection(event);
      return;
    }
    if (shouldApplyRippleRangeAtPointer(event.clientX)) {
      event.preventDefault();
      event.stopPropagation();
      applyRippleDeleteToSelectedRange();
      return;
    }
    const viewport = timelineViewportForTrack(track);
    const target = event.currentTarget as HTMLDivElement | null;
    if (!viewport || !target) return;
    event.preventDefault();

    const pointerId = event.pointerId;
    const group = track.kind === "audio" ? "audio" : track.kind === "video" ? "asset" : null;
    const originLeft = viewport.scrollLeft;
    const originTop = viewport.scrollTop;
    const startX = event.clientX;
    const startY = event.clientY;

    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      target.classList.remove("is-panning");
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextLeft = Math.max(0, originLeft - (moveEvent.clientX - startX));
      const nextTop = Math.max(0, originTop - (moveEvent.clientY - startY));
      if (Math.abs(viewport.scrollLeft - nextLeft) > 0.5) viewport.scrollLeft = nextLeft;
      if (group && Math.abs(viewport.scrollTop - nextTop) > 0.5) viewport.scrollTop = nextTop;
      syncHorizontalScroll(viewport);
      if (group) syncMirroredVerticalScroll(group, viewport);
    };

    const onUp = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      cleanup();
    };

    target.classList.add("is-panning");
    target.setPointerCapture?.(pointerId);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const beginTimelineRangeSelection = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLDivElement | null;
    const pointerId = event.pointerId;
    const originTime = getTimeFromPointer(event.clientX);
    setTimelineRangeSelection({ start: originTime, end: originTime });
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
      setTimelineRangeSelection({
        start: originTime,
        end: getTimeFromPointer(moveEvent.clientX),
      });
    };
    const onUp = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const endTime = getTimeFromPointer(moveEvent.clientX);
      if (Math.abs(endTime - originTime) < 0.02) {
        clearTimelineRange();
      } else {
        setTimelineRangeSelection({ start: originTime, end: endTime });
      }
      cleanup();
    };

    target?.setPointerCapture?.(pointerId);
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const beginClipDrag = (event: PointerEvent, clip: TimelineClip) => {
    if (timelineTool() !== "select") return;
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
        const nextProject = upsertClips(current, updates);
        return syncGeneratedSubtitlesWithMovedAudioClips(
          current,
          nextProject,
          updates.map((item) => item.id),
        );
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

  const beginClipSlip = (event: PointerEvent, clip: TimelineClip) => {
    event.preventDefault();
    event.stopPropagation();
    const currentProject = project();
    if (!currentProject) return;
    const linked = linkedClips(currentProject, clip.id);
    const origins = new Map(
      linked.map((item) => [item.id, { sourceIn: item.source_in, sourceOut: item.source_out }]),
    );
    const startX = event.clientX;
    selectClip(clip, clip.track_id);
    const onMove = (moveEvent: PointerEvent) => {
      const desiredDelta = (moveEvent.clientX - startX) / pxPerSecond();
      props.updateProject((current) => {
        const resolvedDelta = resolveClipGroupSlipDelta(current, linked, desiredDelta);
        const updates = linked.flatMap((item) => {
          const currentClip = getClip(current, item.id);
          const origin = origins.get(item.id);
          if (!currentClip || !origin) return [];
          return [{
            ...currentClip,
            source_in: origin.sourceIn + resolvedDelta,
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

  const trimEdgeFromPointer = (event: PointerEvent): "start" | "end" => {
    const target = event.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    if (!rect) return "end";
    return event.clientX - rect.left <= rect.right - event.clientX ? "start" : "end";
  };

  const beginClipToolInteraction = (event: PointerEvent, clip: TimelineClip) => {
    const tool = timelineTool();
    if (tool === "trim") {
      selectClip(clip, clip.track_id);
      beginTrim(event, clip, trimEdgeFromPointer(event));
      return;
    }
    if (tool === "slip") {
      beginClipSlip(event, clip);
      return;
    }
    beginClipDrag(event, clip);
  };

  const beginSubtitleDrag = (event: PointerEvent, caption: SubtitleBlock, trackId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (editingSubtitleId() === caption.id) return;
    const currentProject = project();
    if (!currentProject) return;
    selectSubtitle(caption, trackId);
    const ownerClip = caption.source_clip_id ? getClip(currentProject, caption.source_clip_id) : null;
    const clipStart = ownerClip?.start ?? 0;
    const clipEnd = ownerClip ? ownerClip.start + (ownerClip.source_out - ownerClip.source_in) : Number.POSITIVE_INFINITY;
    const startX = event.clientX;
    const originStart = caption.start;
    const durationSec = Math.max(MIN_SUBTITLE_DURATION, caption.end - caption.start);
    const onMove = (moveEvent: PointerEvent) => {
      const deltaSec = (moveEvent.clientX - startX) / pxPerSecond();
      const desiredStart = originStart + deltaSec;
      const maxStart = Number.isFinite(clipEnd)
        ? Math.max(clipStart, clipEnd - durationSec)
        : Number.POSITIVE_INFINITY;
      const nextStart = Math.max(clipStart, Math.min(maxStart, desiredStart));
      props.updateProject((current) => patchSubtitle(current, caption.id, {
        start: nextStart,
        end: nextStart + durationSec,
      }));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const beginTrim = (event: PointerEvent, clip: TimelineClip, edge: "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip, clip.track_id);
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

  const beginSubtitleTrim = (
    event: PointerEvent,
    caption: SubtitleBlock,
    edge: "start" | "end",
    trackId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (editingSubtitleId() === caption.id) return;
    const currentProject = project();
    if (!currentProject) return;
    selectSubtitle(caption, trackId);
    const ownerClip = caption.source_clip_id ? getClip(currentProject, caption.source_clip_id) : null;
    const clipStart = ownerClip?.start ?? 0;
    const clipEnd = ownerClip ? ownerClip.start + (ownerClip.source_out - ownerClip.source_in) : Number.POSITIVE_INFINITY;
    const onMove = (moveEvent: PointerEvent) => {
      const pointerTime = getTimeFromPointer(moveEvent.clientX);
      props.updateProject((current) => {
        const currentCaption = getSubtitleBlock(current, caption.id);
        if (!currentCaption) return current;
        if (edge === "start") {
          const maxStart = currentCaption.end - MIN_SUBTITLE_DURATION;
          const nextStart = Math.max(clipStart, Math.min(maxStart, pointerTime));
          return patchSubtitle(current, caption.id, { start: nextStart });
        }
        const minEnd = currentCaption.start + MIN_SUBTITLE_DURATION;
        const nextEnd = Math.max(minEnd, Math.min(clipEnd, pointerTime));
        return patchSubtitle(current, caption.id, { end: nextEnd });
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
    if (timelineTool() === "range") {
      beginTimelineRangeSelection(event);
      return;
    }
    if (shouldApplyRippleRangeAtPointer(event.clientX)) {
      event.preventDefault();
      event.stopPropagation();
      applyRippleDeleteToSelectedRange();
      return;
    }
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
  const trackTimelineClips = (current: EditorialProject, trackId: string) =>
    current.clips
      .filter((clip) => clip.track_id === trackId)
      .sort((left, right) => (
        (left.start - right.start)
        || (Number(left.enabled) - Number(right.enabled))
        || (left.z_index - right.z_index)
        || left.id.localeCompare(right.id)
      ));
  const renderTimelineRangeOverlay = (variant: "ruler" | "body") => {
    const currentRange = timelineRange();
    if (!currentRange) return null;
    return (
      <div
        class={`tl-range-selection tl-range-selection--${variant}`}
        style={{
          left: `${toPx(currentRange.start)}px`,
          width: `${Math.max(1, currentRange.duration * pxPerSecond())}px`,
        }}
      >
        <Show when={variant === "ruler"}>
          <span class="tl-range-selection-label">
            {fmtTimePrecise(currentRange.start)} - {fmtTimePrecise(currentRange.end)}
          </span>
        </Show>
      </div>
    );
  };
  const renderTrackLabel = (track: TimelineTrack, variant: "default" | "editorial" = "default") => (
    <div
      role="button"
      tabIndex={0}
      class={`tl-label tl-label--dynamic${variant === "editorial" ? " tl-label--middle-lane" : ""}${selectedTrackId() === track.id ? " active" : ""}`}
      style={{ height: `${renderedTrackHeight(track)}px` }}
      onClick={() => selectTrack(track.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectTrack(track.id);
      }}
    >
      <div class="tl-lane-card">
        <div class="tl-lane-head">
          <Show when={track.kind === "subtitle"}>
            <span class="tl-lane-icon tl-lane-icon--subtitle">
              <IconBracketsContain />
            </span>
          </Show>
          <Show when={track.kind === "audio"}>
            <span class="tl-lane-icon tl-lane-icon--audio">
              <IconWaveSquare />
            </span>
          </Show>
          <Show when={track.kind === "video"}>
            <span class="tl-lane-icon tl-lane-icon--video">
              <IconVideo />
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
          <Show when={track.kind === "subtitle"}>
            <span class="tl-lane-meta">Edits</span>
          </Show>
        </div>

        <Show when={track.kind === "audio"}>
          <div class="tl-lane-actions">
            <button
              type="button"
              class={`tl-lane-btn tl-lane-btn--mute${track.muted ? " is-active" : ""}`}
              title={track.muted ? "Riattiva audio lane" : "Metti in muto la lane"}
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
            >
              <Show when={!track.muted} fallback={<IconVolumeOff />}>
                <IconVolume2 />
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
              <Show when={track.visible} fallback={<IconEyeOff />}>
                <IconEye />
              </Show>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
  const renderTrackRow = (track: TimelineTrack) => {
    const pendingRanges = track.kind === "audio" ? pendingTrackSubtitleRanges(track.id) : [];
    const generatedGroups = track.kind === "audio" ? generatedTrackSubtitleGroups(track.id) : [];
    const videoMaskGroups = track.kind === "video" ? videoMaskGroupsForLane(project()!, track.id) : [];
    const splitAudioClipIds = new Set<string>();
    if (track.kind === "audio") {
      for (const group of generatedGroups) {
        if (group.sourceClipId) splitAudioClipIds.add(group.sourceClipId);
      }
      if (pendingRanges.length) {
        const pendingClipIds = pendingRanges
          .map((pending) => pending.clipId)
          .filter((clipId): clipId is string => Boolean(clipId));
        if (pendingClipIds.length) {
          for (const clipId of pendingClipIds) splitAudioClipIds.add(clipId);
        }
        if (pendingRanges.some((pending) => !pending.clipId)) {
          for (const clip of trackClips(project()!, track.id)) splitAudioClipIds.add(clip.id);
        }
      }
    }
    const hasAudioSubtitleBand = pendingRanges.length > 0 || generatedGroups.length > 0;
    const hasVideoMaskBand = track.kind === "video" && videoMaskGroups.length > 0;
    return (
    <div
      class={`tl-track tl-track--project tl-track--${track.kind}${track.kind === "subtitle" ? " tl-track--standalone-editorial" : ""}${hasAudioSubtitleBand ? " has-audio-subtitles" : ""}${hasVideoMaskBand ? " has-video-masks" : ""}`}
      style={{ height: `${renderedTrackHeight(track)}px` }}
      onPointerDown={(event) => beginTrackViewportPan(event, track)}
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
      <Show when={track.kind === "audio" && hasAudioSubtitleBand}>
        <div class="tl-audio-subtitle-band">
          <For each={pendingRanges}>
            {(pending) => (
              <div
                class="tl-audio-subtitle-group tl-audio-subtitle-pending-group tl-seg tl-seg--subtitle-pending"
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
          <For each={generatedGroups}>
            {(group) => (
              <AudioSubtitleVisualGroup
                group={group}
                pxPerSecond={pxPerSecond()}
                selectedSubtitleId={selectedSubtitleId()}
                editingSubtitleId={editingSubtitleId()}
                editingSubtitleText={editingSubtitleText()}
                onPointerDown={(event, caption) => beginSubtitleDrag(event, caption, track.id)}
                onTrimPointerDown={(event, caption, edge) => beginSubtitleTrim(event, caption, edge, track.id)}
                onSelect={(caption) => selectSubtitle(caption, track.id)}
                onBeginEdit={(caption) => beginSubtitleEditing(caption, track.id)}
                onEditTextChange={setEditingSubtitleText}
                onCommitEdit={commitSubtitleEditing}
                onCancelEdit={cancelSubtitleEditing}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={track.kind === "video" && hasVideoMaskBand}>
        <div class="tl-video-mask-band">
          <For each={videoMaskGroups}>
            {(group) => {
              const clip = getClip(project()!, group.sourceClipId);
              const asset = assetById(project()!, group.assetId);
              const jobId = selectedJobId();
              if (!clip || !asset || !jobId) return null;
              return (
                <TimelineVideoMaskGroup
                  jobId={jobId}
                  group={group}
                  clip={clip}
                  asset={asset}
                  pxPerSecond={pxPerSecond()}
                />
              );
            }}
          </For>
        </div>
      </Show>
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
        <For each={trackTimelineClips(project()!, track.id)}>
          {(clip) => (
            <button
              type="button"
              class={`tl-seg tl-seg--clip tl-seg--${track.kind}${track.kind === "audio" && splitAudioClipIds.has(clip.id) ? " tl-seg--audio-split" : ""}${track.kind === "video" && hasVideoMaskBand ? " tl-seg--video-split" : ""}${selectedClipId() === clip.id || (selectedLinkedGroupId() && clip.linked_group_id === selectedLinkedGroupId()) ? " is-active" : ""}${clip.enabled ? "" : " is-disabled"}`}
              style={{
                left: `${toPx(clip.start)}px`,
                width: `${Math.max(8, (clip.source_out - clip.source_in) * pxPerSecond())}px`,
              }}
              onPointerDown={(e) => beginClipToolInteraction(e, clip)}
              onClick={(e) => {
                if (applyTimelineToolToClip(e, clip, track)) return;
                if (timelineTool() === "range") {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                e.stopPropagation();
                selectClip(clip, track.id);
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
                            pxPerSecond={pxPerSecond()}
                          />
                        )
                      : <div class="tl-clip-preview-body tl-clip-preview-body--placeholder" aria-hidden="true" />}
                    <div class="tl-clip-footer">
                      <span class="tl-clip-label">{asset?.label || "Clip"}</span>
                    </div>
                  </>
                );
              })()}
              <div class="tl-clip-handle tl-clip-handle--start" onPointerDown={(e) => {
                if (timelineTool() !== "select") return;
                beginTrim(e, clip, "start");
              }} />
              <div class="tl-clip-handle tl-clip-handle--end" onPointerDown={(e) => {
                if (timelineTool() !== "select") return;
                beginTrim(e, clip, "end");
              }} />
            </button>
          )}
        </For>
      </Show>
      <Show when={track.id === captionHostTrackId() || track.kind === "subtitle"}>
        <For each={visibleStandaloneSubtitles(track.id)}>
          {(caption) => (
            <TimelineSubtitleSegment
              caption={caption}
              left={toPx(caption.start)}
              width={Math.max(8, (caption.end - caption.start) * pxPerSecond())}
              selected={selectedSubtitleId() === caption.id}
              editing={editingSubtitleId() === caption.id}
              editText={editingSubtitleId() === caption.id ? editingSubtitleText() : caption.text}
              segmentClass={track.kind === "subtitle" ? editorialDecisionSegmentClass(caption) : undefined}
              onPointerDown={(event, currentCaption) => beginSubtitleDrag(event, currentCaption, track.id)}
              onTrimPointerDown={(event, currentCaption, edge) => beginSubtitleTrim(event, currentCaption, edge, track.id)}
              onSelect={(currentCaption) => selectSubtitle(currentCaption, track.id)}
              onBeginEdit={(currentCaption) => beginSubtitleEditing(currentCaption, track.id)}
              onEditTextChange={setEditingSubtitleText}
              onCommitEdit={commitSubtitleEditing}
              onCancelEdit={cancelSubtitleEditing}
            />
          )}
        </For>
      </Show>
    </div>
  );
  };

  createEffect(() => {
    const viewport = rulerViewportRef ?? assetViewportRef ?? editorialViewportRef ?? audioViewportRef;
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
    editorialLaneVisible();
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
    on(editorialLaneVisible, (visible) => {
      if (!visible) return;
      requestAnimationFrame(() => {
        if (!editorialViewportRef) return;
        editorialViewportRef.scrollLeft = viewportLeft();
        syncHorizontalScroll(editorialViewportRef);
      });
    }),
  );
  createEffect(
    on(
      () => selectedJobId(),
      () => {
        requestedPreviewKeys.clear();
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
    const nextRequests = visiblePreviewState().requests.filter(
      (request) => !requestedPreviewKeys.has(request.key),
    );
    const nextAssetIds = [...new Set(nextRequests.map((request) => request.assetId))];
    if (!nextAssetIds.length) return;
    nextRequests.forEach((request) => requestedPreviewKeys.add(request.key));
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
  createEffect(() => {
    const jobId = selectedJobId();
    const current = project();
    if (!jobId || !current) return;
    const hasRunningBackgroundRemoval = current.assets.some(
      (asset) => asset.background_removal?.status === "running",
    );
    if (!hasRunningBackgroundRemoval) return;
    const handle = window.setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["editorial-project", jobId] });
    }, 1200);
    onCleanup(() => window.clearInterval(handle));
  });
  onCleanup(() => {
    clearTimeout(zoomWheelResetHandle);
    if (horizontalSyncHandle) cancelAnimationFrame(horizontalSyncHandle);
    if (verticalSyncHandle) cancelAnimationFrame(verticalSyncHandle);
  });

  return (
    <div class="panel timeline-panel">
      <div class="panel-header timeline-panel-header">
        <div class="timeline-header-side">
          <div class="timeline-header-label">
            <span class="panel-title">Timeline</span>
            <button
              type="button"
              class={`btn btn-ghost btn-xs timeline-header-lane-toggle${editorialLaneVisible() ? " is-active" : ""}`}
              aria-pressed={editorialLaneVisible()}
              disabled={!editorialTrack()}
              title={editorialLaneVisible() ? "Nascondi lane Editorial" : "Mostra lane Editorial"}
              onClick={() => setEditorialLaneVisible((current) => !current)}
            >
              <Show when={editorialLaneVisible()} fallback={<IconEyeOff size={12} aria-hidden="true" />}>
                <IconEye size={12} aria-hidden="true" />
              </Show>
              <span>Editorial</span>
            </button>
          </div>
        </div>
        <div class="timeline-header-center">
          <div class="timeline-tools">
            <For each={TIMELINE_TOOL_GROUPS}>
              {(group) => (
                <div class="timeline-tool-group">
                  <For each={group}>
                    {(tool) => {
                      const entry = TIMELINE_TOOL_BUTTONS.find((item) => item.tool === tool)!;
                      return (
                        <button
                          type="button"
                          class={`btn btn-xs timeline-tool-btn${entry.danger ? " timeline-tool-btn--danger" : ""}${timelineTool() === entry.tool ? " is-active" : ""}`}
                          aria-label={entry.label}
                          aria-pressed={timelineTool() === entry.tool}
                          title={entry.tooltip}
                          onClick={() => toggleTimelineTool(entry.tool)}
                        >
                          <TimelineToolIcon tool={entry.tool} />
                        </button>
                      );
                    }}
                  </For>
                  <Show when={group.length === 1 && group[0] === "range"}>
                    <button
                      type="button"
                      class={`btn btn-xs timeline-tool-btn timeline-tool-btn--range-loop${timelineRangeLoopEnabled() ? " is-active" : ""}`}
                      aria-label="Loop Range"
                      aria-pressed={timelineRangeLoopEnabled()}
                      title="Loop Range: ripete in playback la selezione temporale attiva."
                      disabled={!timelineRange()}
                      onClick={toggleTimelineRangeLoop}
                    >
                      <IconRepeat aria-hidden="true" />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="timeline-header-side timeline-header-side--right">
          <div class="timeline-toolbar-meta">
            <Show when={hoverTime() !== null}>
              <span class="timeline-zoom-label" style={{ "min-width": "96px" }}>
                Cursor {fmtTimePrecise(hoverTime()!)}
              </span>
            </Show>
            <Show when={timelineRange()}>
              {(range) => (
                <span class="timeline-selection-readout">
                  Range {fmtTimePrecise(range().start)} - {fmtTimePrecise(range().end)} / {fmtTimePrecise(range().duration)}
                </span>
              )}
            </Show>
            <span class="timeline-zoom-label" style={{ "min-width": "60px" }}>{fmtTimePrecise(playheadTime())}</span>
            <Button variant={autoFollow() ? "primary" : "ghost"} size="xs" onClick={() => setAutoFollow(!autoFollow())}>
              Follow
            </Button>
            <Button variant="ghost" size="xs" aria-label="Riduci zoom timeline" onClick={() => setZoomIndex(zoomIdx() - 1)}>
              <IconMinus size={12} />
            </Button>
            <span class="timeline-zoom-label">{zoom()}x</span>
            <Button variant="ghost" size="xs" aria-label="Aumenta zoom timeline" onClick={() => setZoomIndex(zoomIdx() + 1)}>
              <IconPlus size={12} />
            </Button>
          </div>
        </div>
      </div>
      <Show when={project()} fallback={<div class="placeholder">Timeline non disponibile</div>}>
        <div
          class={`timeline-shell${timelineTool() !== "select" ? " has-active-tool" : ""} is-tool-${timelineToolClassName()}`}
          onPointerEnter={updateTimelineHover}
          onPointerMove={updateTimelineHover}
          onPointerLeave={() => setHoverOffset(null)}
        >
          <div
            class={`timeline-body${editorialLaneVisible() && editorialTrack() ? " has-editorial-lane" : ""}`}
            style={{ "--timeline-middle-lane-height": `${EDITORIAL_STANDALONE_HEIGHT}px` }}
          >
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
                {renderTimelineRangeOverlay("ruler")}
                <Show when={hoverTime() !== null}>
                  <div class="tl-hover-line tl-hover-line--ruler" style={{ left: `${toPx(hoverTime()!)}px` }} />
                </Show>
                <div class="tl-playhead tl-playhead--ruler" style={{ left: `${toPx(playheadTime())}px` }} />
                <div class="tl-ruler" onPointerDown={beginRulerScrub}>
                  <For each={rulerTicks()}>
                    {(tick) => (
                      <>
                        <div class={`tl-ruler-tick ${tick.kind}`} style={{ left: `${toPx(tick.time)}px` }} />
                        <Show when={tick.label}>
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
                <For each={videoTracks()}>{(track) => renderTrackLabel(track)}</For>
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
                {renderTimelineRangeOverlay("body")}
                <Show when={hoverTime() !== null}>
                  <div class="tl-hover-line tl-hover-line--body" style={{ left: `${toPx(hoverTime()!)}px` }} />
                </Show>
                <div class="tl-playhead tl-playhead--body" style={{ left: `${toPx(playheadTime())}px` }} />
                <For each={videoTracks()}>{(track) => renderTrackRow(track)}</For>
              </div>
            </div>

            <Show when={editorialLaneVisible() && editorialTrack()}>
              {(track) => (
                <>
                  <div
                    ref={editorialLabelsRef}
                    class="tl-labels tl-labels--editorial"
                  >
                    <div class="tl-labels-inner tl-labels-inner--editorial">
                      {renderTrackLabel(track(), "editorial")}
                    </div>
                  </div>
                  <div
                    ref={editorialViewportRef}
                    class="timeline-viewport timeline-viewport--editorial"
                    onWheel={onTimelineWheel}
                    onScroll={(event) => syncHorizontalScroll(event.currentTarget as HTMLDivElement)}
                  >
                    <div
                      ref={editorialInnerRef}
                      class="timeline-scroll-inner timeline-scroll-inner--editorial"
                      style={{ width: `${contentWidth()}px` }}
                    >
                      {renderTimelineRangeOverlay("body")}
                      <Show when={hoverTime() !== null}>
                        <div class="tl-hover-line tl-hover-line--body" style={{ left: `${toPx(hoverTime()!)}px` }} />
                      </Show>
                      <div class="tl-playhead tl-playhead--body" style={{ left: `${toPx(playheadTime())}px` }} />
                      {renderTrackRow(track())}
                    </div>
                  </div>
                </>
              )}
            </Show>

            <div
              ref={audioLabelsRef}
              class="tl-labels tl-labels--group tl-labels--audio"
              onScroll={onGroupLabelsScroll("audio")}
            >
              <div class="tl-labels-inner tl-labels-inner--audio">
                <For each={audioTracks()}>{(track) => renderTrackLabel(track)}</For>
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
                {renderTimelineRangeOverlay("body")}
                <Show when={hoverTime() !== null}>
                  <div class="tl-hover-line tl-hover-line--body" style={{ left: `${toPx(hoverTime()!)}px` }} />
                </Show>
                <div class="tl-playhead tl-playhead--body" style={{ left: `${toPx(playheadTime())}px` }} />
                <For each={audioTracks()}>{(track) => renderTrackRow(track)}</For>
              </div>
            </div>
          </div>
          <div class="tl-minimap" style={{ display: "grid" }}>
            <div class="tl-minimap-label">Overview</div>
            <div class="tl-minimap-content" onPointerDown={onMinimapPointerDown}>
              <For each={overviewClips()}>
                {(clip) => (
                  <div
                    class={`tl-mini-seg tl-mini-seg--${clip.kind}`}
                    style={{
                      left: `${(clip.start / duration()) * 100}%`,
                      width: `${Math.max(0.5, ((clip.end - clip.start) / duration()) * 100)}%`,
                    }}
                  />
                )}
              </For>
              <Show when={editorialLaneVisible()}>
                <For each={overviewSubtitles()}>
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
              </Show>
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
