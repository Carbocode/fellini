import { createEffect, For, on, type Component } from "solid-js";
import { useJobQuery, useRunStepMutation } from "../api/queries";
import { selectedJobId, selectedStep, setSelectedStep } from "../store";
import { capitalize, canRunStep, getNextRunnableStep } from "../lib/utils";
import type { JobSnapshot } from "../types";

const PipelineBar: Component = () => {
  const job = useJobQuery(selectedJobId);
  const runStepMut = useRunStepMutation();

  const data = () => job.data as JobSnapshot | undefined;

  // Auto-select the current/first-incomplete step when job loads or changes
  createEffect(
    on(
      () => data()?.id,
      () => {
        const j = data();
        if (!j) return;
        // If no step selected yet, or the selected step doesn't belong to this job
        if (!selectedStep() || !j.steps.some((s) => s.name === selectedStep())) {
          const next = j.steps.find((s) => s.status !== "completed");
          setSelectedStep(next ? next.name : j.steps[j.steps.length - 1]?.name ?? null);
        }
      },
    ),
  );

  const nextStep = () => {
    const j = data();
    return j ? getNextRunnableStep(j) : null;
  };

  const handleRunNext = () => {
    const j = data();
    const step = nextStep();
    if (j && step) {
      runStepMut.mutate({ jobId: j.id, stepName: step });
    }
  };

  const handleRunAll = () => {
    // Run the next step — polling will pick up completion and the UI
    // will update. The backend auto-chains in automatic mode.
    handleRunNext();
  };

  return (
    <div class="pipeline-bar">
      <div class="pipeline-steps">
        <For each={data()?.steps ?? []}>
          {(step, i) => (
            <>
              {i() > 0 && <span class="step-connector" />}
              <button
                type="button"
                class={`pipeline-step ${step.status}${selectedStep() === step.name ? " selected" : ""}`}
                onClick={() => setSelectedStep(step.name)}
                title={step.message || step.name}
              >
                <span class="step-dot" />
                <span>{capitalize(step.name)}</span>
              </button>
            </>
          )}
        </For>
      </div>
      <div class="pipeline-actions">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={!nextStep() || data()?.status === "running"}
          onClick={handleRunAll}
        >
          {data()?.status === "running"
            ? "In esecuzione..."
            : nextStep()
              ? `Esegui ${capitalize(nextStep()!)}`
              : "Pipeline completa"}
        </button>
      </div>
    </div>
  );
};

export default PipelineBar;
