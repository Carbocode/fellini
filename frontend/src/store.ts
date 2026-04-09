import { createEffect, createSignal } from "solid-js";

// ---- Tab system ----
// Each tab is either a job ID (string) or null (new tab page)
export type Tab = { id: string | null; label: string };

function readJobIdFromHash(): string | null {
  const match = location.hash.match(/^#\/project\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

const initialJobId = readJobIdFromHash();
const initialTabs: Tab[] = initialJobId
  ? [{ id: initialJobId, label: "..." }]
  : [{ id: null, label: "Nuovo" }];

export const [tabs, setTabs] = createSignal<Tab[]>(initialTabs);
export const [activeTabIdx, setActiveTabIdx] = createSignal(0);

// Derived: the currently active tab's job ID
export const selectedJobId = () => tabs()[activeTabIdx()]?.id ?? null;

export function openTab(jobId: string | null, label?: string) {
  setTabs((prev) => [...prev, { id: jobId, label: label || (jobId ? "..." : "Nuovo") }]);
  setActiveTabIdx(tabs().length - 1);
}

export function closeTab(idx: number) {
  const t = tabs();
  if (t.length <= 1) {
    // Always keep at least one tab
    setTabs([{ id: null, label: "Nuovo" }]);
    setActiveTabIdx(0);
    return;
  }
  const next = t.filter((_, i) => i !== idx);
  setTabs(next);
  if (activeTabIdx() >= next.length) {
    setActiveTabIdx(next.length - 1);
  } else if (activeTabIdx() > idx) {
    setActiveTabIdx(activeTabIdx() - 1);
  }
}

export function selectProjectInTab(jobId: string, label: string) {
  const idx = activeTabIdx();
  setTabs((prev) => prev.map((t, i) => (i === idx ? { id: jobId, label } : t)));
}

export function updateTabLabel(jobId: string, label: string) {
  setTabs((prev) => prev.map((t) => (t.id === jobId ? { ...t, label } : t)));
}

// Sync active tab -> URL hash
createEffect(() => {
  const id = selectedJobId();
  const newHash = id ? `#/project/${id}` : "";
  if (location.hash !== newHash) {
    history.replaceState(null, "", newHash || location.pathname);
  }
});

window.addEventListener("hashchange", () => {
  const id = readJobIdFromHash();
  if (id && id !== selectedJobId()) {
    // Check if already open in a tab
    const existing = tabs().findIndex((t) => t.id === id);
    if (existing >= 0) {
      setActiveTabIdx(existing);
    } else {
      openTab(id);
    }
  }
});

export const [selectedStep, setSelectedStep] = createSignal<string | null>(null);
export const [dialogOpen, setDialogOpen] = createSignal(false);
export const [aboutDialogOpen, setAboutDialogOpen] = createSignal(false);

// Per-job UI state keyed by job ID
const previewMap: Record<string, string> = {};
const monitorMap: Record<string, string> = {};

export const [previewByJob, setPreviewByJob] = createSignal<Record<string, string>>({});
export const [monitorByJob, setMonitorByJob] = createSignal<Record<string, string>>({});

export function setPreviewForJob(jobId: string, path: string) {
  previewMap[jobId] = path;
  setPreviewByJob({ ...previewMap });
}

export function setMonitorForJob(jobId: string, path: string) {
  monitorMap[jobId] = path;
  setMonitorByJob({ ...monitorMap });
}

export function getPreviewForJob(jobId: string): string | undefined {
  return previewByJob()[jobId];
}

export function getMonitorForJob(jobId: string): string | undefined {
  return monitorByJob()[jobId];
}

// Shared playhead
export const [playheadTime, setPlayheadTime] = createSignal(0);
export const [seekRequest, setSeekRequest] = createSignal<number | null>(null);
export const [playPauseRequest, setPlayPauseRequest] = createSignal(0);
export const [autoFollow, setAutoFollow] = createSignal(true);

// Frame step
export const [frameStepRequest, setFrameStepRequest] = createSignal<number>(0);

// Transcript editing
export const [editingWord, setEditingWord] = createSignal<{ seg: number; word: number } | null>(null);
export const [selectedTrackId, setSelectedTrackId] = createSignal<string | null>(null);
export const [selectedClipId, setSelectedClipId] = createSignal<string | null>(null);
export const [selectedSubtitleId, setSelectedSubtitleId] = createSignal<string | null>(null);
