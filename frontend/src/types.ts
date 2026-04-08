export type JobStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed";
export type StepName = "ingest" | "transcription" | "editorial" | "render";

export interface StepSnapshot {
  name: StepName;
  status: StepStatus;
  progress: number;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  artifacts: string[];
  can_run: boolean;
  blocked_reason: string;
}

export interface InputAsset {
  original_name: string;
  stored_name: string;
  media_kind: string;
}

export interface PipelineToggles {
  use_whisperx: boolean;
  use_local_llm: boolean;
  use_diarization: boolean;
  render_clean: boolean;
  render_captioned: boolean;
}

export interface TranscriptionConfig {
  model: string;
  beam_size: number;
  vad_filter: boolean;
  condition_on_prev_text: boolean;
  word_timestamps: boolean;
  compute_type: string;
  device: string;
}

export interface SubtitleConfig {
  chunk_words: number;
  font_name: string;
  font_size: number;
  text_color: string;
  active_color: string;
  outline_color: string;
  bottom_margin: number;
  pop_in_ms: number;
}

export interface RenderConfig {
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string;
  crf: number;
  preset: string;
  audio_bitrate: string;
}

export interface DecisionConfig {
  filler_words: string[];
  repetition_window_seconds: number;
  soft_pause_threshold_seconds: number;
  hard_pause_threshold_seconds: number;
  leading_context_seconds: number;
  trailing_context_seconds: number;
  retained_pause_seconds: number;
  local_model_name: string;
}

export interface JobRequest {
  title: string;
  language: string;
  editorial_notes: string;
  input_assets: InputAsset[];
  toggles: PipelineToggles;
  transcription: TranscriptionConfig;
  subtitle: SubtitleConfig;
  render: RenderConfig;
  decision: DecisionConfig;
}

export interface JobSnapshot {
  id: string;
  title: string;
  status: JobStatus;
  request: JobRequest;
  steps: StepSnapshot[];
  created_at: string;
  updated_at: string;
  current_step: StepName | null;
  error: string | null;
  workspace: string;
  logs: string[];
  outputs: string[];
}

export interface ArtifactEntry {
  path: string;
  step: string;
}

export interface PreviewData {
  type: "json" | "text";
  text: string;
  data?: unknown;
}

export type ProjectAssetKind = "video" | "audio";
export type TimelineTrackKind = "video" | "audio" | "subtitle";
export type AudioTrackRole = "story" | "support";
export type ClipOrigin = "generated" | "manual";
export type LaneTranscriptionStatus = "idle" | "running" | "completed" | "failed";
export type AssetPreviewStatus = "missing" | "generating" | "ready" | "failed";
export type AssetVariantKind = "original" | "cutout";
export type AssetProcessingStatus = "idle" | "running" | "completed" | "failed";

export interface ClipCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  crop: ClipCrop;
}

export interface ClipAudio {
  gain: number;
  muted: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
}

export interface AssetPreviewEntry {
  status: AssetPreviewStatus;
  resource_path: string | null;
  version: number;
  error: string | null;
  meta: Record<string, unknown>;
}

export interface AssetPreviewBundle {
  filmstrip: AssetPreviewEntry | null;
  waveform: AssetPreviewEntry | null;
}

export interface AssetPreviewVariants {
  original: AssetPreviewBundle | null;
  cutout: AssetPreviewBundle | null;
}

export interface AssetBackgroundRemoval {
  status: AssetProcessingStatus;
  active_variant: AssetVariantKind;
  phase: string | null;
  progress: number;
  message: string;
  error: string | null;
  original_path: string | null;
  cutout_path: string | null;
  alpha_path: string | null;
  compare_path: string | null;
  benchmark_path: string | null;
  progress_path: string | null;
  updated_at: string;
}

export interface ProjectAsset {
  id: string;
  origin: string;
  kind: ProjectAssetKind;
  label: string;
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  sample_rate: number | null;
  has_audio: boolean;
  transcript_ref: string | null;
  preview: AssetPreviewVariants | null;
  background_removal: AssetBackgroundRemoval | null;
}

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  name: string;
  order: number;
  visible: boolean;
  muted: boolean;
  locked: boolean;
  auto_generated: boolean;
  role: AudioTrackRole | null;
}

export interface TimelineClip {
  id: string;
  asset_id: string;
  track_id: string;
  linked_group_id: string | null;
  start: number;
  source_in: number;
  source_out: number;
  z_index: number;
  enabled: boolean;
  origin: ClipOrigin;
  asset_variant: AssetVariantKind;
  transform: ClipTransform;
  audio: ClipAudio;
  captions_enabled: boolean;
}

export interface SourceWordRef {
  segment_id: string;
  word_index: number;
}

export interface SubtitleBlock {
  id: string;
  track_id: string;
  source_lane_id: string;
  source_clip_id: string | null;
  source_asset_id: string | null;
  source_asset_start: number | null;
  source_asset_end: number | null;
  start: number;
  end: number;
  text: string;
  origin: ClipOrigin;
  source_word_refs: SourceWordRef[];
}

export interface AssetTranscriptionWord {
  id: string;
  start: number;
  end: number;
  text: string;
  source_word_refs: SourceWordRef[];
}

export interface AssetTranscription {
  asset_id: string;
  language: string;
  words: AssetTranscriptionWord[];
  source_lane_id: string | null;
  source_audio_path: string | null;
  updated_at: string;
  error: string | null;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: WordTiming[];
}

export interface LaneTranscription {
  lane_id: string;
  status: LaneTranscriptionStatus;
  language: string;
  segments: TranscriptSegment[];
  source_audio_path: string | null;
  updated_at: string;
  error: string | null;
}

export interface ProjectSequence {
  width: number;
  height: number;
  fps: number;
  sample_rate: number;
  background: string;
}

export interface ProjectSelection {
  track_id: string | null;
  clip_id: string | null;
  subtitle_block_id: string | null;
}

export interface EditorialProject {
  version: number;
  revision: number;
  sequence: ProjectSequence;
  assets: ProjectAsset[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  captions: SubtitleBlock[];
  asset_transcriptions: AssetTranscription[];
  lane_transcriptions: LaneTranscription[];
  selection: ProjectSelection;
  updated_at: string;
}

export interface LaneTranscriptionResponse {
  job: JobSnapshot;
  project: EditorialProject;
}
