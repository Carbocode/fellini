import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import * as api from "./client";
import type { JobSnapshot } from "../types";

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

export function useCreateJobMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (formData: FormData) => api.createJob(formData),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
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
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job", vars.jobId] });
      // Invalidate artifacts — steps produce new ones
      qc.invalidateQueries({ queryKey: ["artifact", vars.jobId] });
    },
  }));
}

export function useUpdateTranscriptMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; transcript: unknown }) =>
      api.updateTranscript(vars.jobId, vars.transcript),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job", vars.jobId] });
      qc.invalidateQueries({ queryKey: ["artifact", vars.jobId] });
    },
  }));
}

export function useUpdateRequestMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; payload: Record<string, unknown> }) =>
      api.updateRequest(vars.jobId, vars.payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job", vars.jobId] });
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
          qc.setQueryData(["job", id], fresh);
          qc.invalidateQueries({ queryKey: ["jobs"] });
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
    steps: job.steps.map((s) => ({ name: s.name, status: s.status, artifacts: s.artifacts })),
    outputs: job.outputs,
    logCount: job.logs.length,
  });
}
