import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import * as api from "./client";
import type { EditorialProject, JobSnapshot } from "../types";

function syncJobSnapshot(qc: ReturnType<typeof useQueryClient>, snapshot: JobSnapshot) {
  qc.setQueryData(["job", snapshot.id], snapshot);
  const jobs = qc.getQueryData<JobSnapshot[]>(["jobs"]);
  if (!jobs) return;

  const nextJobs = jobs.some((job) => job.id === snapshot.id)
    ? jobs.map((job) => (job.id === snapshot.id ? snapshot : job))
    : [snapshot, ...jobs];
  qc.setQueryData(["jobs"], nextJobs);
}

export function useConfigQuery() {
  return createQuery(() => ({
    queryKey: ["config"],
    queryFn: api.fetchConfig,
    staleTime: Infinity,
  }));
}

export function useJobsQuery() {
  return createQuery(() => ({
    queryKey: ["jobs"],
    queryFn: api.fetchJobs,
    staleTime: 5_000,
    refetchOnMount: "always" as const,
  }));
}

export function useJobQuery(jobId: Accessor<string | null>) {
  return createQuery(() => ({
    queryKey: ["job", jobId()],
    queryFn: () => api.fetchJob(jobId()!),
    enabled: !!jobId(),
    staleTime: 10_000,
  }));
}

export function useArtifactQuery(
  jobId: Accessor<string | null>,
  path: Accessor<string | null>,
) {
  return createQuery(() => ({
    queryKey: ["artifact", jobId(), path()],
    queryFn: () => api.fetchArtifact(jobId()!, path()!),
    enabled: !!jobId() && !!path(),
    staleTime: 60_000,
  }));
}

export function useEditorialProjectQuery(jobId: Accessor<string | null>) {
  return createQuery(() => ({
    queryKey: ["editorial-project", jobId()],
    queryFn: () => api.fetchEditorialProject(jobId()!),
    enabled: !!jobId(),
    staleTime: 2_000,
  }));
}

export function useCreateJobMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (formData: FormData) => api.createJob(formData),
    onSuccess: (snapshot) => {
      syncJobSnapshot(qc, snapshot);
    },
  }));
}

export function useDeleteJobMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (jobId: string) => api.deleteJob(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  }));
}

export function useRunStepMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; stepName: string }) =>
      api.runStep(vars.jobId, vars.stepName),
    onSuccess: (snapshot) => {
      syncJobSnapshot(qc, snapshot);
      qc.invalidateQueries({ queryKey: ["artifact", snapshot.id] });
      qc.invalidateQueries({ queryKey: ["editorial-project", snapshot.id] });
    },
    onError: (_error, vars) => {
      qc.invalidateQueries({ queryKey: ["job", vars.jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["artifact", vars.jobId] });
      qc.invalidateQueries({ queryKey: ["editorial-project", vars.jobId] });
    },
  }));
}

export function useUpdateTranscriptMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; transcript: unknown; target: "transcription" | "alignment" }) =>
      api.updateTranscript(vars.jobId, vars.transcript, vars.target),
    onSuccess: (snapshot) => {
      syncJobSnapshot(qc, snapshot);
      qc.invalidateQueries({ queryKey: ["artifact", snapshot.id] });
      qc.invalidateQueries({ queryKey: ["editorial-project", snapshot.id] });
    },
  }));
}

export function useUpdateRequestMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; payload: Record<string, unknown> }) =>
      api.updateRequest(vars.jobId, vars.payload),
    onSuccess: (snapshot) => {
      syncJobSnapshot(qc, snapshot);
      qc.invalidateQueries({ queryKey: ["artifact", snapshot.id] });
      qc.invalidateQueries({ queryKey: ["editorial-project", snapshot.id] });
    },
  }));
}

export function useUpdateEditorialProjectMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; project: EditorialProject }) =>
      api.updateEditorialProject(vars.jobId, vars.project),
    onSuccess: (project, vars) => {
      qc.setQueryData(["editorial-project", vars.jobId], project);
    },
  }));
}

export function useUploadEditorialAssetMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; file: File }) =>
      api.uploadEditorialAsset(vars.jobId, vars.file),
    onSuccess: (payload, vars) => {
      qc.setQueryData(["editorial-project", vars.jobId], payload.project);
    },
  }));
}

export function useTranscribeLaneMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; laneId: string }) =>
      api.transcribeAudioLane(vars.jobId, vars.laneId),
    onSuccess: (payload, vars) => {
      syncJobSnapshot(qc, payload.job);
      qc.setQueryData(["editorial-project", vars.jobId], payload.project);
      qc.invalidateQueries({ queryKey: ["artifact", vars.jobId] });
    },
  }));
}

/**
 * Smart polling hook. Only refetches when the selected job is running.
 * Compares the response fingerprint before invalidating to avoid
 * unnecessary re-renders (the real fix for Solid's reactivity).
 */
export function useJobPolling(jobId: Accessor<string | null>) {
  const qc = useQueryClient();
  let fingerprint = "";
  let handle: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    stop();
    handle = setInterval(async () => {
      const id = jobId();
      if (!id) return;

      try {
        const fresh = await api.fetchJob(id);
        const fp = jobFingerprint(fresh);
        if (fp !== fingerprint) {
          fingerprint = fp;
          syncJobSnapshot(qc, fresh);
          // If step just completed, refresh artifacts
          qc.invalidateQueries({ queryKey: ["artifact", id] });
        }
      } catch {
        // ignore network errors during poll
      }
    }, 3000);
  };

  const stop = () => {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  };

  return { start, stop };
}

/** Fingerprint that only includes fields we care about for re-rendering. */
function jobFingerprint(job: JobSnapshot): string {
  return JSON.stringify({
    status: job.status,
    current_step: job.current_step,
    error: job.error,
    steps: job.steps.map((s) => ({
      name: s.name,
      status: s.status,
      progress: s.progress,
      message: s.message,
      artifacts: s.artifacts,
    })),
    outputs: job.outputs,
    logCount: job.logs.length,
  });
}
