import { Show, createMemo, type Accessor, type Component } from "solid-js";
import { selectedClipId, selectedSubtitleId, selectedTrackId } from "../store";
import type { EditorialProject } from "../types";
import {
  assetById,
  getClip,
  getSubtitleBlock,
  getTrack,
  patchSubtitle,
  setStoryLane,
} from "../lib/editorial";
import { fmtTimePrecise } from "../lib/utils";

const ParamsInspector: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: EditorialProject | ((current: EditorialProject) => EditorialProject)) => void;
}> = (props) => {
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
  const currentLaneTranscription = createMemo(() => {
    const project = props.project();
    const lane = currentTrack();
    if (!project || !lane || lane.kind !== "audio") return null;
    return project.lane_transcriptions.find((item) => item.lane_id === lane.id) ?? null;
  });

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
                  <span>{assetById(props.project()!, clip().asset_id)?.label || "Clip"}</span>
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
