export type JobStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed";
export type StepName = "ingest" | "transcription" | "alignment" | "editorial" | "render";
export type RunProfile = "fast" | "balanced" | "quality" | "custom";
export type ExecutionMode = "automatic" | "step_by_step";

export interface StepSnapshot {
  name: StepName;
  status: StepStatus;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  artifacts: string[];
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
  profile: RunProfile;
  execution_mode: ExecutionMode;
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

export interface AppConfig {
  profiles: RunProfile[];
  execution_modes: ExecutionMode[];
  step_names: StepName[];
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
