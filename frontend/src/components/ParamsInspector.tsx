import { For, Show, createMemo, type Accessor, type Component, type JSX } from "solid-js";
import {
  selectedJobId,
  selectedClipId,
  selectedSubtitleId,
  selectedTrackId,
  setSelectedClipId,
  setSelectedSubtitleId,
} from "../store";
import type { ClipTranscriptionOptions, EditorialProject } from "../types";
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
  removeClip,
  removeSubtitle,
  setStoryLane,
} from "../lib/editorial";
import { fmtTimePrecise } from "../lib/utils";

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

const InspectorAccordion: Component<{
  symbol: string;
  title: string;
  meta?: string;
  open?: boolean;
  children?: JSX.Element;
}> = (props) => (
  <details class="inspector-accordion" open={props.open}>
    <summary class="inspector-accordion-summary">
      <div class="inspector-accordion-head">
        <span class="inspector-accordion-symbol" aria-hidden="true">{props.symbol}</span>
        <div class="inspector-accordion-copy">
          <span class="inspector-accordion-title">{props.title}</span>
          <Show when={props.meta}>
            <span class="inspector-accordion-meta">{props.meta}</span>
          </Show>
        </div>
      </div>
      <span class="inspector-accordion-caret" aria-hidden="true">{">"}</span>
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
  const deleteSelectedClip = () => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => removeClip(project, clip.id));
    setSelectedClipId(null);
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

  return (
    <div class="panel inspector-panel">
      <Show when={props.project()} fallback={<div class="placeholder">Seleziona un progetto</div>}>
        <div>
          <Show when={currentTrack()}>
            {(track) => (
              <div class="inspector-card">
                <div class="inspector-card-title">Lane selezionata</div>
                <div class="inspector-accordion-stack">
                  <InspectorAccordion symbol="==" title="Contesto lane" meta={track().kind} open>
                    <div class="inspector-card-row">
                      <span>{track().name}</span>
                      <span class="timeline-mode-tag">{track().kind}</span>
                    </div>
                    <Show when={track().kind === "audio"}>
                      <div class="inspector-card-row">
                        <span>Role: {track().role ?? "support"}</span>
                        <button
                          type="button"
                          class={`btn btn-xs ${track().role === "story" ? "btn-primary" : "btn-ghost"}`}
                          onClick={() => props.updateProject((project) => setStoryLane(project, track().id))}
                        >
                          {track().role === "story" ? "Story lane" : "Set story"}
                        </button>
                      </div>
                    </Show>
                  </InspectorAccordion>
                </div>
              </div>
            )}
          </Show>

          <Show when={currentClip()}>
            {(clip) => (
              <div class="inspector-card">
                <div class="inspector-card-title">Clip selezionata</div>
                <div class="inspector-accordion-stack">
                  <InspectorAccordion symbol="[]" title="Clip" meta={currentAsset()?.label || "Clip"} open>
                    <div class="inspector-card-row">
                      <span>Timeline</span>
                      <span>{fmtTimePrecise(clip().start)} - {fmtTimePrecise(clip().start + (clip().source_out - clip().source_in))}</span>
                    </div>
                    <div class="inspector-card-row">
                      <span>Source in</span>
                      <span>{fmtTimePrecise(clip().source_in)}</span>
                    </div>
                    <div class="inspector-card-row">
                      <span>Source out</span>
                      <span>{fmtTimePrecise(clip().source_out)}</span>
                    </div>
                    <div class="inspector-card-row">
                      <span>Origine</span>
                      <span>{clip().origin}</span>
                    </div>
                    <div class="inspector-card-row">
                      <span>Link</span>
                      <span>{clip().linked_group_id ? "A/V linked" : "Independent"}</span>
                    </div>
                  </InspectorAccordion>
                </div>
                <Show when={currentTrack()?.kind === "audio"}>
                  <div class="inspector-accordion-stack">
                    <InspectorAccordion
                      symbol="~"
                      title="Setup ASR"
                      meta={`${effectiveClipLanguage()} / ${effectiveClipModel()} / b${effectiveClipBeamSize()}`}
                      open
                    >
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
                        <Show when={clip().transcription_options.language !== null}>
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
                        <Show when={clip().transcription_options.model !== null}>
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
                          value={clip().transcription_options.beam_size ?? ""}
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
                        <Show when={clip().transcription_options.vad_filter !== null}>
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
                        <Show when={clip().transcription_options.use_whisperx !== null}>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs"
                            onClick={() => updateClipTranscriptionOptions({ use_whisperx: null })}
                          >
                            Reset
                          </button>
                        </Show>
                      </div>
                    </InspectorAccordion>

                    <InspectorAccordion
                      symbol="#"
                      title="Transcript"
                      meta={`${clip().transcription_status} / ${currentClipTranscriptionWordCount()} parole`}
                      open
                    >
                      <div class="inspector-card-row">
                        <span>Transcription</span>
                        <span>{clip().transcription_status}</span>
                      </div>
                      <Show when={clip().transcription_message}>
                        <div class="inspector-card-row">
                          <span>Stato</span>
                          <span>{clip().transcription_message}</span>
                        </div>
                      </Show>
                      <Show when={clip().transcription_status === "running" && currentTranscriptionStep()}>
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
                      <Show when={clip().transcription_source_audio_path}>
                        <div class="inspector-card-row">
                          <span>Audio bounce</span>
                          <span>{clip().transcription_source_audio_path}</span>
                        </div>
                      </Show>
                      <Show when={currentClipTranscriptPreview()}>
                        <label class="param-field">
                          <span>Anteprima transcript</span>
                          <textarea value={currentClipTranscriptPreview()} readonly rows={4} />
                        </label>
                      </Show>
                      <Show when={clip().transcription_status === "completed" && !currentClipTranscriptPreview() && !clip().transcription_message}>
                        <div class="inspector-card-row">
                          <span>Risultato</span>
                          <span>Nessuna parola disponibile</span>
                        </div>
                      </Show>
                      <Show when={clip().transcription_error}>
                        <div class="step-message">{clip().transcription_error}</div>
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
                    </InspectorAccordion>
                  </div>
                </Show>
                <Show when={currentAsset()?.kind === "video" && currentTrack()?.kind === "video"}>
                  <div class="inspector-accordion-stack">
                    <InspectorAccordion symbol="<>" title="Scontorno" meta={backgroundRemoval()?.status ?? "idle"} open>
                      <div class="inspector-card-row">
                        <span>Background removal</span>
                        <span>{backgroundRemoval()?.status ?? "idle"}</span>
                      </div>
                      <Show when={backgroundRemoval()}>
                        {(cutout) => (
                          <>
                            <div class="inspector-card-row">
                              <span>Variante clip</span>
                              <span>{clip().asset_variant === "cutout" ? "Scontornato" : "Originale"}</span>
                            </div>
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
                            class={`inspector-segmented__option ${clip().asset_variant === "original" ? "is-active" : ""}`}
                            aria-pressed={clip().asset_variant === "original"}
                            disabled={backgroundRemoval()?.status === "running" || !backgroundRemoval()?.original_path}
                            onClick={() => switchClipVariant("original")}
                          >
                            Originale
                          </button>
                          <button
                            type="button"
                            class={`inspector-segmented__option ${clip().asset_variant === "cutout" ? "is-active" : ""}`}
                            aria-pressed={clip().asset_variant === "cutout"}
                            disabled={backgroundRemoval()?.status === "running" || !backgroundRemoval()?.cutout_path}
                            onClick={() => switchClipVariant("cutout")}
                          >
                            Scontornato
                          </button>
                        </div>
                      </div>
                    </InspectorAccordion>
                  </div>
                </Show>
                <div class="inspector-accordion-stack">
                  <InspectorAccordion symbol="!" title="Azioni" meta="distruttive">
                    <div class="inspector-card-actions">
                      <button
                        type="button"
                        class="btn btn-xs btn-danger"
                        onClick={deleteSelectedClip}
                      >
                        Elimina clip
                      </button>
                    </div>
                  </InspectorAccordion>
                </div>
              </div>
            )}
          </Show>

          <Show when={currentSubtitle()}>
            {(subtitle) => (
              <div class="inspector-card">
                <div class="inspector-card-title">Subtitle block</div>
                <label class="param-field">
                  <span>Testo</span>
                  <textarea
                    value={subtitle().text}
                    onInput={(e) =>
                      props.updateProject((project) =>
                        patchSubtitle(project, subtitle().id, { text: e.currentTarget.value })
                      )}
                  />
                </label>
                <label class="param-field">
                  <span>Start</span>
                  <input
                    type="number"
                    step="0.01"
                    value={subtitle().start}
                    onInput={(e) =>
                      props.updateProject((project) =>
                        patchSubtitle(project, subtitle().id, { start: Number(e.currentTarget.value) })
                      )}
                  />
                </label>
                <label class="param-field">
                  <span>End</span>
                  <input
                    type="number"
                    step="0.01"
                    value={subtitle().end}
                    onInput={(e) =>
                      props.updateProject((project) =>
                        patchSubtitle(project, subtitle().id, { end: Number(e.currentTarget.value) })
                      )}
                  />
                </label>
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
            )}
          </Show>

          <Show when={!currentTrack() && !currentClip() && !currentSubtitle()}>
            <div class="inspector-card">
              <div class="inspector-card-title">Selezione</div>
              <div class="step-message">
                Seleziona una lane, una clip o un blocco testo dalla timeline per modificarne il contesto.
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ParamsInspector;
