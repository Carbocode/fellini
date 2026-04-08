import { Show, createMemo, type Accessor, type Component } from "solid-js";
import {
  selectedJobId,
  selectedClipId,
  selectedSubtitleId,
  selectedTrackId,
  setSelectedClipId,
  setSelectedSubtitleId,
} from "../store";
import type { EditorialProject } from "../types";
import {
  useStartBackgroundRemovalMutation,
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

const ParamsInspector: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: EditorialProject | ((current: EditorialProject) => EditorialProject)) => void;
}> = (props) => {
  const startBackgroundRemoval = useStartBackgroundRemovalMutation();
  const currentTrack = createMemo(() => {
    const project = props.project();
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
  const currentLaneTranscription = createMemo(() => {
    const project = props.project();
    const lane = currentTrack();
    if (!project || !lane || lane.kind !== "audio") return null;
    return project.lane_transcriptions.find((item) => item.lane_id === lane.id) ?? null;
  });
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
                <div class="inspector-card-row">
                  <span>{track().name}</span>
                  <span class="timeline-mode-tag">{track().kind}</span>
                </div>
                <Show when={track().kind === "audio"}>
                  <>
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
                    <div class="inspector-card-row">
                      <span>Transcription</span>
                      <span>{currentLaneTranscription()?.status ?? "idle"}</span>
                    </div>
                    <Show when={currentLaneTranscription()}>
                      {(transcription) => (
                        <div class="inspector-card-row">
                          <span>Segmenti</span>
                          <span>{transcription().segments.length}</span>
                        </div>
                      )}
                    </Show>
                  </>
                </Show>
              </div>
            )}
          </Show>

          <Show when={currentClip()}>
            {(clip) => (
              <div class="inspector-card">
                <div class="inspector-card-title">Clip selezionata</div>
                <div class="inspector-card-row">
                  <span>{currentAsset()?.label || "Clip"}</span>
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
                <Show when={currentAsset()?.kind === "video" && currentTrack()?.kind === "video"}>
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
                </Show>
                <div class="inspector-card-actions">
                  <button
                    type="button"
                    class="btn btn-xs btn-danger"
                    onClick={deleteSelectedClip}
                  >
                    Elimina clip
                  </button>
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
