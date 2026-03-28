import { For, Show, createMemo, type Component } from "solid-js";
import {
  useEditorialProjectQuery,
  useJobQuery,
  useRunStepMutation,
  useTranscribeLaneMutation,
} from "../api/queries";
import { selectedJobId, selectedTrackId } from "../store";
import { getTrack, isAudioTrack } from "../lib/editorial";
import { canRunStep, capitalize } from "../lib/utils";

type ToolStep = "transcription" | "editorial" | "render";

const TOOL_CONFIG: Array<{ step: ToolStep; label: string; hint: string }> = [
  {
    step: "transcription",
    label: "Sottotitoli",
    hint: "Genera blocchi testo dalla lane audio selezionata",
  },
  {
    step: "editorial",
    label: "Editorial",
    hint: "Aggiorna il montaggio automatico dalla story lane",
  },
  {
    step: "render",
    label: "Render",
    hint: "Esporta il montaggio finale del progetto",
  },
];

const PipelineBar: Component = () => {
  const job = useJobQuery(selectedJobId);
  const project = useEditorialProjectQuery(selectedJobId);
  const runStepMut = useRunStepMutation();
  const transcribeLaneMut = useTranscribeLaneMutation();

  const selectedAudioLane = createMemo(() => {
    const currentProject = project.data ?? null;
    if (!currentProject) return null;
    const lane = getTrack(currentProject, selectedTrackId());
    return isAudioTrack(lane) ? lane : null;
  });

  const stepSnapshot = (name: ToolStep) =>
    (job.data?.steps ?? []).find((step) => step.name === name) ?? null;

  const runningStep = createMemo(
    () => (job.data?.steps ?? []).find((step) => step.status === "running") ?? null,
  );

  const canUseTool = (name: ToolStep) => {
    if (!job.data || job.data.status === "running") return false;
    if (name === "transcription") {
      return !!selectedAudioLane() && canRunStep(job.data, name);
    }
    return canRunStep(job.data, name);
  };

  const toolMeta = (name: ToolStep) => {
    if (name === "transcription") {
      return selectedAudioLane()?.name ?? "Seleziona una lane audio";
    }
    if (name === "editorial") {
      const storyLane = project.data?.tracks.find(
        (track) => track.kind === "audio" && track.role === "story",
      );
      return storyLane ? `Story lane: ${storyLane.name}` : "Seleziona una story lane";
    }
    return "Export finale del progetto";
  };

  const triggerTool = (name: ToolStep) => {
    const currentJob = job.data;
    if (!currentJob || !canUseTool(name)) return;
    if (name === "transcription") {
      const laneId = selectedAudioLane()?.id;
      if (!laneId) return;
      transcribeLaneMut.mutate({ jobId: currentJob.id, laneId });
      return;
    }
    runStepMut.mutate({ jobId: currentJob.id, stepName: name });
  };

  const buttonLabel = (name: ToolStep) => {
    if (name === "transcription" && transcribeLaneMut.isPending) return "Trascrizione...";
    if (runStepMut.isPending && runningStep()?.name === name) return "In esecuzione...";
    return TOOL_CONFIG.find((tool) => tool.step === name)?.label ?? capitalize(name);
  };

  return (
    <div class="pipeline-bar">
      <div class="pipeline-tools">
        <For each={TOOL_CONFIG}>
          {(tool) => {
            const snapshot = () => stepSnapshot(tool.step);
            return (
              <button
                type="button"
                class={`pipeline-tool ${snapshot()?.status ?? "pending"}`}
                disabled={!canUseTool(tool.step)}
                title={snapshot()?.blocked_reason || tool.hint}
                onClick={() => triggerTool(tool.step)}
              >
                <span class="pipeline-tool-dot" />
                <span class="pipeline-tool-copy">
                  <span class="pipeline-tool-label">{buttonLabel(tool.step)}</span>
                  <span class="pipeline-tool-meta">{toolMeta(tool.step)}</span>
                </span>
                <Show when={snapshot()?.progress && snapshot()!.progress > 0 && snapshot()!.progress < 100}>
                  <span class="pipeline-tool-progress">{Math.round(snapshot()!.progress)}%</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      <div class="pipeline-status">
        <Show
          when={runningStep()}
          fallback={
            <span class="pipeline-status-text">
              {selectedAudioLane()
                ? `Lane attiva: ${selectedAudioLane()!.name}`
                : "Aggiungi asset e seleziona una lane per usare i tool"}
            </span>
          }
        >
          {(step) => (
            <span class="pipeline-status-text">
              {capitalize(step().name)} in esecuzione
              <Show when={step().progress > 0}>
                <> {Math.round(step().progress)}%</>
              </Show>
            </span>
          )}
        </Show>
      </div>
    </div>
  );
};

export default PipelineBar;
