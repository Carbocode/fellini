import type {
  ClipTranscriptionOptions,
  EditorialProject,
  JobSnapshot,
  ProjectAsset,
  TranscriptionResponse,
} from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Errore" }));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchJobs(): Promise<JobSnapshot[]> {
  return json(await fetch("/api/jobs", { cache: "no-store" }));
}

export async function fetchJob(jobId: string): Promise<JobSnapshot> {
  return json(await fetch(`/api/jobs/${jobId}`, { cache: "no-store" }));
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
  target: "transcription" | "alignment",
): Promise<JobSnapshot> {
  return json(
    await fetch(`/api/jobs/${jobId}/transcript?target=${target}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transcript),
    }),
  );
}

export async function runStep(
  jobId: string,
  stepName: string,
): Promise<JobSnapshot> {
  return json(
    await fetch(`/api/jobs/${jobId}/steps/${stepName}/run`, { method: "POST" }),
  );
}

export async function fetchEditorialProject(jobId: string): Promise<EditorialProject> {
  return json(await fetch(`/api/jobs/${jobId}/editorial-project`, { cache: "no-store" }));
}

export async function updateEditorialProject(
  jobId: string,
  project: EditorialProject,
): Promise<EditorialProject> {
  return json(
    await fetch(`/api/jobs/${jobId}/editorial-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    }),
  );
}

export async function uploadEditorialAsset(
  jobId: string,
  file: File,
): Promise<{ asset: ProjectAsset; project: EditorialProject }> {
  const formData = new FormData();
  formData.append("file", file);
  return json(
    await fetch(`/api/jobs/${jobId}/assets`, {
      method: "POST",
      body: formData,
    }),
  );
}

export async function startAssetBackgroundRemoval(
  jobId: string,
  assetId: string,
): Promise<EditorialProject> {
  return json(
    await fetch(`/api/jobs/${jobId}/assets/${assetId}/background-removal`, {
      method: "POST",
    }),
  );
}

export async function deleteEditorialAsset(
  jobId: string,
  assetId: string,
): Promise<EditorialProject> {
  return json(
    await fetch(`/api/jobs/${jobId}/assets/${assetId}`, {
      method: "DELETE",
    }),
  );
}

export async function transcribeAudioLane(
  jobId: string,
  laneId: string,
): Promise<TranscriptionResponse> {
  return json(
    await fetch(`/api/jobs/${jobId}/audio-lanes/${laneId}/transcribe`, {
      method: "POST",
    }),
  );
}

export async function transcribeAudioClip(
  jobId: string,
  clipId: string,
  options?: ClipTranscriptionOptions,
): Promise<TranscriptionResponse> {
  return json(
    await fetch(`/api/jobs/${jobId}/clips/${clipId}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    }),
  );
}

export async function requestAssetPreviews(
  jobId: string,
  assetIds: string[],
): Promise<EditorialProject> {
  return json(
    await fetch(`/api/jobs/${jobId}/asset-previews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset_ids: assetIds }),
    }),
  );
}

export async function fetchArtifact(
  jobId: string,
  path: string,
): Promise<{ type: "json" | "text"; text: string; data?: unknown }> {
  const res = await fetch(`/jobs/${jobId}/files/${encodeURI(path)}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Non disponibile");
  const text = await res.text();
  try {
    return { type: "json", text, data: JSON.parse(text) };
  } catch {
    return { type: "text", text };
  }
}

export function fileUrl(
  jobId: string,
  relativePath: string,
  options?: { download?: boolean },
): string {
  const base = `/jobs/${jobId}/files/${encodeURI(relativePath)}`;
  return options?.download ? `${base}?download=1` : base;
}
