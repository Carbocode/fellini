import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { useJobsQuery, useDeleteJobMutation } from "../api/queries";
import { selectProjectInTab, updateTabLabel, setDialogOpen, tabs, closeTab } from "../store";
import type { JobSnapshot } from "../types";

const NewTabPage: Component = () => {
  const jobs = useJobsQuery();
  const deleteJob = useDeleteJobMutation();
  const [filter, setFilter] = createSignal("");

  const allJobs = createMemo(() => (jobs.data as JobSnapshot[] | undefined) ?? []);
  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim();
    const list = allJobs();
    if (!q) return list;
    return list.filter((j) => j.title.toLowerCase().includes(q) || j.id.includes(q));
  });

  const openProject = (job: JobSnapshot) => {
    selectProjectInTab(job.id, job.title);
    updateTabLabel(job.id, job.title);
  };

  const handleDelete = (e: MouseEvent, job: JobSnapshot) => {
    e.stopPropagation();
    if (job.status === "running") return;
    if (!confirm(`Eliminare "${job.title}"?`)) return;
    deleteJob.mutate(job.id, {
      onSuccess: () => {
        // Close any tabs that had this project open
        tabs().forEach((t, i) => {
          if (t.id === job.id) closeTab(i);
        });
      },
    });
  };

  return (
    <div class="new-tab-page">
      <div class="ntp-content">
        <div class="ntp-header">
          <h1 class="ntp-title">Fellini</h1>
          <p class="ntp-subtitle">Seleziona un progetto o creane uno nuovo</p>
        </div>

        <div class="ntp-actions">
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => setDialogOpen(true)}
          >
            Nuovo progetto
          </button>
          <div class="ntp-search">
            <input
              type="text"
              placeholder="Cerca progetti..."
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
        </div>

        <Show
          when={allJobs().length > 0}
          fallback={
            <div class="ntp-empty">
              {jobs.isLoading ? "Caricamento..." : "Nessun progetto. Creane uno nuovo."}
            </div>
          }
        >
          <div class="ntp-project-grid">
            <For each={filtered()}>
              {(job) => (
                <div class="ntp-project-card" onClick={() => openProject(job)}>
                  <div class="ntp-card-header">
                    <span class={`status-dot ${job.status}`} />
                    <span class="ntp-card-title">{job.title}</span>
                    <button
                      type="button"
                      class="btn-delete ntp-delete"
                      title="Elimina progetto"
                      disabled={job.status === "running"}
                      onClick={(e) => handleDelete(e, job)}
                    >
                      x
                    </button>
                  </div>
                  <div class="ntp-card-meta">
                    <span>{job.request.profile}</span>
                    <span>{job.request.execution_mode === "step_by_step" ? "manual" : "auto"}</span>
                    <span>{job.steps.filter((s) => s.status === "completed").length}/{job.steps.length} steps</span>
                  </div>
                  <div class="ntp-card-id">{job.id}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default NewTabPage;
