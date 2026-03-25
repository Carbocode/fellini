import { createEffect, For, on, type Component } from "solid-js";
import { useJobQuery, useRunStepMutation } from "../api/queries";
import { selectedJobId, selectedStep, setSelectedStep } from "../store";
import { capitalize, canRunStep } from "../lib/utils";
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

  const currentStep = () => {
    const j = data();
    const stepName = selectedStep();
    if (!j || !stepName) return null;
    return j.steps.find((step) => step.name === stepName) ?? null;
  };

  const canRunCurrentStep = () => {
    const j = data();
    const step = currentStep();
    return !!j && !!step && canRunStep(j, step.name);
  };

  const handleRunCurrent = () => {
    const j = data();
    const step = currentStep();
    if (!j || !step || !canRunStep(j, step.name)) return;
    runStepMut.mutate({ jobId: j.id, stepName: step.name });
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
                title={step.blocked_reason || step.message || step.name}
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
          disabled={!canRunCurrentStep() || data()?.status === "running"}
          onClick={handleRunCurrent}
          title={currentStep()?.blocked_reason || ""}
        >
          {data()?.status === "running"
            ? "In esecuzione..."
            : currentStep()
              ? `${currentStep()!.status === "completed" ? "Riesegui" : "Esegui"} ${capitalize(currentStep()!.name)}`
              : "Seleziona step"}
        </button>
      </div>
    </div>
  );
};

export default PipelineBar;
