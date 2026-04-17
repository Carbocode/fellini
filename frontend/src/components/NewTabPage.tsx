import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { useJobsQuery, useDeleteJobMutation } from "../api/queries";
import { selectProjectInTab, updateTabLabel, setDialogOpen, tabs, closeTab } from "../store";
import type { JobSnapshot } from "../types";
import { Button, Input } from "./ui";

function projectCanvasLabel(job: JobSnapshot): string {
  return `${job.request.render.width}×${job.request.render.height}`;
}

function projectSubtitle(job: JobSnapshot): string {
  const notes = job.request.editorial_notes.trim();
  if (notes) return notes;
  return `Canvas ${projectCanvasLabel(job)} · ${job.request.language.toUpperCase()}`;
}

function updatedAtLabel(value: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

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
          <p class="ntp-subtitle">Apri un progetto e continua il montaggio</p>
        </div>

        <div class="ntp-actions">
          <Button onClick={() => setDialogOpen(true)}>
            Nuovo progetto
          </Button>
          <div class="ntp-search">
            <Input
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
                  <div class="ntp-card-subtitle">{projectSubtitle(job)}</div>
                  <div class="ntp-card-meta">
                    <span>{projectCanvasLabel(job)}</span>
                    <span>{job.request.language.toUpperCase()}</span>
                    <span>{updatedAtLabel(job.updated_at)}</span>
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
