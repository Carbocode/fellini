import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import * as api from "./client";
import type { EditorialProject, JobSnapshot } from "../types";
import { normalizeEditorialProject } from "../lib/editorial";

function syncJobSnapshot(qc: ReturnType<typeof useQueryClient>, snapshot: JobSnapshot) {
  qc.setQueryData(["job", snapshot.id], snapshot);
  const jobs = qc.getQueryData<JobSnapshot[]>(["jobs"]);
  if (!jobs) return;

  const nextJobs = jobs.some((job) => job.id === snapshot.id)
    ? jobs.map((job) => (job.id === snapshot.id ? snapshot : job))
    : [snapshot, ...jobs];
  qc.setQueryData(["jobs"], nextJobs);
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
    queryFn: async () => normalizeEditorialProject(await api.fetchEditorialProject(jobId()!)),
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
      qc.setQueryData(["editorial-project", vars.jobId], normalizeEditorialProject(project));
    },
  }));
}

export function useUploadEditorialAssetMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; file: File }) =>
      api.uploadEditorialAsset(vars.jobId, vars.file),
    onSuccess: (payload, vars) => {
      qc.setQueryData(["editorial-project", vars.jobId], normalizeEditorialProject(payload.project));
    },
  }));
}

export function useTranscribeLaneMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    onMutate: async (vars) => {
      const projectQueryKey = ["editorial-project", vars.jobId] as const;
      const previousProject = qc.getQueryData<EditorialProject>(projectQueryKey) ?? null;
      const previousJob = qc.getQueryData<JobSnapshot>(["job", vars.jobId]) ?? null;

      if (previousJob) {
        const nextJob: JobSnapshot = {
          ...previousJob,
          status: "running",
          current_step: "transcription",
          steps: previousJob.steps.map((step) =>
            step.name === "transcription"
              ? {
                  ...step,
                  status: "running",
                  progress: Math.max(step.progress, 1),
                  message: "Trascrizione della lane in corso",
                  started_at: step.started_at ?? new Date().toISOString(),
                  finished_at: null,
                }
              : step
          ),
        };
        syncJobSnapshot(qc, nextJob);
      }

      if (!previousProject) {
        return { previousProject, previousJob, projectQueryKey };
      }

      const currentLane = previousProject.lane_transcriptions.find(
        (lane) => lane.lane_id === vars.laneId,
      );
      const nextProject = normalizeEditorialProject({
        ...previousProject,
        lane_transcriptions: [
          ...previousProject.lane_transcriptions.filter((lane) => lane.lane_id !== vars.laneId),
          {
            lane_id: vars.laneId,
            status: "running",
            language: currentLane?.language ?? "it",
            segments: currentLane?.segments ?? [],
            source_audio_path: currentLane?.source_audio_path ?? null,
            updated_at: new Date().toISOString(),
            error: null,
          },
        ],
      });
      qc.setQueryData(projectQueryKey, nextProject);
      return { previousProject, previousJob, projectQueryKey };
    },
    mutationFn: (vars: { jobId: string; laneId: string }) =>
      api.transcribeAudioLane(vars.jobId, vars.laneId),
    onSuccess: (payload, vars) => {
      syncJobSnapshot(qc, payload.job);
      qc.setQueryData(["editorial-project", vars.jobId], normalizeEditorialProject(payload.project));
      qc.invalidateQueries({ queryKey: ["artifact", vars.jobId] });
    },
    onError: (_error, vars) => {
      qc.invalidateQueries({ queryKey: ["job", vars.jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["editorial-project", vars.jobId] });
    },
  }));
}

export function useRequestAssetPreviewsMutation() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { jobId: string; assetIds: string[] }) =>
      api.requestAssetPreviews(vars.jobId, vars.assetIds),
    onSuccess: (project, vars) => {
      qc.setQueryData(["editorial-project", vars.jobId], normalizeEditorialProject(project));
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
