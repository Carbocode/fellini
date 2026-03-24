import type { AppConfig, JobSnapshot } from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Errore" }));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchConfig(): Promise<AppConfig> {
  return json(await fetch("/api/config"));
}

export async function fetchJobs(): Promise<JobSnapshot[]> {
  return json(await fetch("/api/jobs"));
}

export async function fetchJob(jobId: string): Promise<JobSnapshot> {
  return json(await fetch(`/api/jobs/${jobId}`));
}

export async function createJob(formData: FormData): Promise<JobSnapshot> {
  return json(await fetch("/api/jobs", { method: "POST", body: formData }));
}

export async function updateRequest(
  jobId: string,
  payload: Record<string, unknown>,
): Promise<JobSnapshot> {
  return json(
    await fetch(`/api/jobs/${jobId}/request`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function deleteJob(jobId: string): Promise<{ deleted: boolean }> {
  return json(await fetch(`/api/jobs/${jobId}`, { method: "DELETE" }));
}

export async function updateTranscript(
  jobId: string,
  transcript: unknown,
): Promise<JobSnapshot> {
  return json(
    await fetch(`/api/jobs/${jobId}/transcript`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transcript),
    }),
  );
}

export async function runStep(
  jobId: string,
  stepName: string,
): Promise<{ accepted: boolean }> {
  return json(
    await fetch(`/api/jobs/${jobId}/steps/${stepName}/run`, { method: "POST" }),
  );
}

export async function fetchArtifact(
  jobId: string,
  path: string,
): Promise<{ type: "json" | "text"; text: string; data?: unknown }> {
  const res = await fetch(`/jobs/${jobId}/files/${encodeURI(path)}`);
  if (!res.ok) throw new Error("Non disponibile");
  const text = await res.text();
  try {
    return { type: "json", text, data: JSON.parse(text) };
  } catch {
    return { type: "text", text };
  }
}

export function fileUrl(jobId: string, relativePath: string): string {
  return `/jobs/${jobId}/files/${encodeURI(relativePath)}`;
}
