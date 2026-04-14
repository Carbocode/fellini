import type { ArtifactEntry, JobSnapshot, StepName } from "../types";

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fmtTime(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtTimePrecise(seconds: number): string {
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

export function baseName(path: string): string {
  return path.split("/").pop() || path;
}

export function inferFileType(
  path: string,
): "video" | "audio" | "json" | "text" | "binary" {
  if (/\.(mp4|mov|webm)$/i.test(path)) return "video";
  if (/\.(wav|mp3|aac|m4a)$/i.test(path)) return "audio";
  if (/\.json$/i.test(path)) return "json";
  if (/\.(ass|txt|log)$/i.test(path)) return "text";
  return "binary";
}

export function isPreviewableText(path: string): boolean {
  const t = inferFileType(path);
  return t === "json" || t === "text";
}

export function humanizeMediaName(path: string): string {
  if (path.endsWith("edited_master.mp4")) return "Render";
  if (path.endsWith("source_mezzanine.mp4")) return "Source";
  if (path.endsWith("audio_16k_mono.wav")) return "Audio";
  return baseName(path);
}

export function buildArtifactCatalog(job: JobSnapshot): ArtifactEntry[] {
  const items: ArtifactEntry[] = [];
  const seen = new Set<string>();
  for (const step of job.steps) {
    for (const path of step.artifacts) {
      if (!seen.has(path)) {
        seen.add(path);
        items.push({ path, step: step.name });
      }
    }
  }
  for (const path of job.outputs) {
    if (!seen.has(path)) {
      seen.add(path);
      items.push({ path, step: "output" });
    }
  }
  return items;
}

const MONITOR_ORDER = [
  "edited_master.mp4",
  "source_mezzanine.mp4",
  "audio_16k_mono.wav",
];

export function getMonitorSources(
  job: JobSnapshot,
): { path: string; label: string }[] {
  const catalog = buildArtifactCatalog(job);
  const sourceInputLabel = (() => {
    const labels = (job.request.input_assets ?? [])
      .map((asset) => baseName(asset.original_name))
      .filter(Boolean);
    if (!labels.length) return null;
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
  })();
  return MONITOR_ORDER.map((suffix) => catalog.find((i) => i.path.endsWith(suffix)))
    .filter(Boolean)
    .map((i) => ({
      path: i!.path,
      label: i!.path.endsWith("source_mezzanine.mp4")
        ? (sourceInputLabel ?? humanizeMediaName(i!.path))
        : humanizeMediaName(i!.path),
    }));
}

export function canRunStep(job: JobSnapshot, stepName: string): boolean {
  if (job.status === "running") return false;
  const step = job.steps.find((s) => s.name === stepName);
  if (!step) return false;
  return step.can_run;
}

export function getNextRunnableStep(job: JobSnapshot): StepName | null {
  const next = job.steps.find((s) => s.status !== "completed");
  if (!next) return null;
  return canRunStep(job, next.name) ? next.name : null;
}
