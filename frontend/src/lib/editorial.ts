import type {
  AudioTrackRole,
  EditorialProject,
  ProjectAsset,
  SubtitleBlock,
  TimelineClip,
  TimelineTrack,
  TimelineTrackKind,
} from "../types";

function clipDuration(clip: Pick<TimelineClip, "source_in" | "source_out">): number {
  return Math.max(0, clip.source_out - clip.source_in);
}

export function projectDuration(project: EditorialProject): number {
  const clipEnd = project.clips.reduce(
    (max, clip) => Math.max(max, clip.start + clipDuration(clip)),
    0,
  );
  const subtitleEnd = project.captions.reduce((max, caption) => Math.max(max, caption.end), 0);
  return Math.max(clipEnd, subtitleEnd, 0);
}

export function getTrack(project: EditorialProject, trackId: string | null): TimelineTrack | null {
  if (!trackId) return null;
  return project.tracks.find((track) => track.id === trackId) ?? null;
}

export function getClip(project: EditorialProject, clipId: string | null): TimelineClip | null {
  if (!clipId) return null;
  return project.clips.find((clip) => clip.id === clipId) ?? null;
}

export function getSubtitleBlock(
  project: EditorialProject,
  subtitleId: string | null,
): SubtitleBlock | null {
  if (!subtitleId) return null;
  return project.captions.find((caption) => caption.id === subtitleId) ?? null;
}

export function sortedTracks(project: EditorialProject): TimelineTrack[] {
  return [...project.tracks].sort((a, b) => a.order - b.order);
}

export function trackClips(project: EditorialProject, trackId: string): TimelineClip[] {
  return project.clips
    .filter((clip) => clip.track_id === trackId && clip.enabled)
    .sort((a, b) => (a.start - b.start) || (a.z_index - b.z_index));
}

export function trackSubtitles(project: EditorialProject, trackId: string): SubtitleBlock[] {
  return project.captions
    .filter((caption) => caption.track_id === trackId)
    .sort((a, b) => a.start - b.start);
}

export function assetById(project: EditorialProject, assetId: string): ProjectAsset | undefined {
  return project.assets.find((asset) => asset.id === assetId);
}

function firstTrackOfKind(project: EditorialProject, kind: TimelineTrackKind): TimelineTrack | undefined {
  return sortedTracks(project).find((track) => track.kind === kind);
}

function preferredAudioTrack(project: EditorialProject): TimelineTrack | undefined {
  return sortedTracks(project).find((track) => track.kind === "audio" && track.role === "story")
    ?? firstTrackOfKind(project, "audio");
}

type PlacementInterval = { min: number; max: number };

function intersectIntervals(
  left: PlacementInterval[],
  right: PlacementInterval[],
): PlacementInterval[] {
  const result: PlacementInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const min = Math.max(left[i].min, right[j].min);
    const max = Math.min(left[i].max, right[j].max);
    if (max >= min) result.push({ min, max });
    if (left[i].max <= right[j].max) i += 1;
    else j += 1;
  }
  return result;
}

function resolveValueInIntervals(value: number, intervals: PlacementInterval[]): number {
  if (!intervals.length) return Math.max(0, value);
  let bestValue = Math.max(intervals[0].min, Math.min(intervals[0].max, value));
  let bestDistance = Math.abs(bestValue - value);
  for (const interval of intervals) {
    const candidate = Math.max(interval.min, Math.min(interval.max, value));
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestValue = candidate;
      bestDistance = distance;
    }
  }
  return bestValue;
}

function trackPlacementIntervals(
  project: EditorialProject,
  clip: Pick<TimelineClip, "id" | "track_id" | "source_in" | "source_out">,
  excludeClipIds: Set<string>,
): PlacementInterval[] {
  const duration = clipDuration(clip);
  const others = trackClips(project, clip.track_id).filter((item) => !excludeClipIds.has(item.id));
  const intervals: PlacementInterval[] = [];
  let cursor = 0;
  for (const other of others) {
    const intervalMax = other.start - duration;
    if (intervalMax >= cursor) intervals.push({ min: cursor, max: intervalMax });
    cursor = Math.max(cursor, other.start + clipDuration(other));
  }
  intervals.push({ min: cursor, max: Number.POSITIVE_INFINITY });
  return intervals;
}

function trackNeighborBounds(
  project: EditorialProject,
  clip: Pick<TimelineClip, "id" | "track_id" | "start" | "source_in" | "source_out">,
  excludeClipIds: Set<string>,
): { prevEnd: number; nextStart: number } {
  let prevEnd = 0;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const other of trackClips(project, clip.track_id)) {
    if (excludeClipIds.has(other.id)) continue;
    const otherEnd = other.start + clipDuration(other);
    if (otherEnd <= clip.start) prevEnd = Math.max(prevEnd, otherEnd);
    if (other.start >= clip.start + clipDuration(clip)) nextStart = Math.min(nextStart, other.start);
  }
  return { prevEnd, nextStart };
}

export function resolveClipGroupStart(
  project: EditorialProject,
  clips: Array<Pick<TimelineClip, "id" | "track_id" | "start" | "source_in" | "source_out">>,
  desiredStart: number,
  excludeClipIds: string[] = [],
): number {
  if (!clips.length) return Math.max(0, desiredStart);
  const excludeSet = new Set(excludeClipIds);
  const anchorStart = Math.min(...clips.map((clip) => clip.start));
  let sharedIntervals: PlacementInterval[] = [{ min: 0, max: Number.POSITIVE_INFINITY }];
  for (const clip of clips) {
    const offset = clip.start - anchorStart;
    const shifted = trackPlacementIntervals(project, clip, excludeSet).map((interval) => ({
      min: Math.max(0, interval.min - offset),
      max: Number.isFinite(interval.max) ? interval.max - offset : Number.POSITIVE_INFINITY,
    }));
    sharedIntervals = intersectIntervals(sharedIntervals, shifted);
    if (!sharedIntervals.length) return Math.max(0, desiredStart);
  }
  return resolveValueInIntervals(desiredStart, sharedIntervals);
}

export function resolveClipGroupTrimStartDelta(
  project: EditorialProject,
  clips: TimelineClip[],
  desiredDelta: number,
  excludeClipIds: string[] = [],
): number {
  const excludeSet = new Set(excludeClipIds);
  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const { prevEnd } = trackNeighborBounds(project, clip, excludeSet);
    minDelta = Math.max(minDelta, -clip.source_in, prevEnd - clip.start);
    maxDelta = Math.min(maxDelta, clipDuration(clip) - 0.02);
  }
  return Math.min(maxDelta, Math.max(minDelta, desiredDelta));
}

export function resolveClipGroupTrimEndDelta(
  project: EditorialProject,
  clips: TimelineClip[],
  desiredDelta: number,
  excludeClipIds: string[] = [],
): number {
  const excludeSet = new Set(excludeClipIds);
  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const { nextStart } = trackNeighborBounds(project, clip, excludeSet);
    const assetDuration = assetById(project, clip.asset_id)?.duration ?? 0;
    minDelta = Math.max(minDelta, 0.02 - clipDuration(clip));
    if (assetDuration > 0) maxDelta = Math.min(maxDelta, assetDuration - clip.source_out);
    if (Number.isFinite(nextStart)) maxDelta = Math.min(maxDelta, nextStart - (clip.start + clipDuration(clip)));
  }
  return Math.min(maxDelta, Math.max(minDelta, desiredDelta));
}

export function dropPreviewTargets(
  project: EditorialProject,
  asset: ProjectAsset,
  track: TimelineTrack,
): TimelineTrack[] {
  if (track.kind === "subtitle") return [];
  if (asset.kind !== "video" || !asset.has_audio) return [track];

  const videoTrack = track.kind === "video" ? track : firstTrackOfKind(project, "video");
  const audioTrack = track.kind === "audio" ? track : preferredAudioTrack(project);
  return [videoTrack, audioTrack].filter((item): item is TimelineTrack => Boolean(item));
}

export function createClip(
  _project: EditorialProject,
  asset: ProjectAsset,
  track: TimelineTrack,
  start: number,
  options?: { linkedGroupId?: string | null },
): TimelineClip {
  return {
    id: `clip_${crypto.randomUUID()}`,
    asset_id: asset.id,
    track_id: track.id,
    linked_group_id: options?.linkedGroupId ?? null,
    start: Math.max(0, start),
    source_in: 0,
    source_out: Math.max(0.02, asset.duration || 3),
    z_index: 0,
    enabled: true,
    origin: "manual",
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    audio: {
      gain: 1,
      muted: false,
      fade_in_ms: 0,
      fade_out_ms: 0,
    },
    captions_enabled: true,
  };
}

export function createClipsForAssetDrop(
  project: EditorialProject,
  asset: ProjectAsset,
  track: TimelineTrack,
  start: number,
): { clips: TimelineClip[]; primaryClipId: string | null } {
  if (track.kind === "subtitle") return { clips: [], primaryClipId: null };
  if (asset.kind !== "video" || !asset.has_audio) {
    const clip = createClip(project, asset, track, start);
    const resolvedStart = resolveClipGroupStart(project, [clip], start);
    return { clips: [{ ...clip, start: resolvedStart }], primaryClipId: clip.id };
  }

  const targets = dropPreviewTargets(project, asset, track);
  const videoTrack = targets.find((item) => item.kind === "video");
  const audioTrack = targets.find((item) => item.kind === "audio");
  if (!videoTrack && !audioTrack) return { clips: [], primaryClipId: null };

  const linkedGroupId = videoTrack && audioTrack ? `link_${crypto.randomUUID()}` : null;
  const clips: TimelineClip[] = [];
  let primaryClipId: string | null = null;
  if (videoTrack) {
    const clip = createClip(project, asset, videoTrack, start, { linkedGroupId });
    clips.push(clip);
    if (track.kind === "video") primaryClipId = clip.id;
  }
  if (audioTrack) {
    const clip = createClip(project, asset, audioTrack, start, { linkedGroupId });
    clips.push(clip);
    if (track.kind === "audio" || !primaryClipId) primaryClipId = clip.id;
  }
  const resolvedStart = resolveClipGroupStart(project, clips, start);
  return {
    clips: clips.map((clip) => ({ ...clip, start: resolvedStart })),
    primaryClipId: primaryClipId ?? clips[0]?.id ?? null,
  };
}

export function compatibleTrack(asset: ProjectAsset, track: TimelineTrack): boolean {
  if (track.kind === "subtitle") return false;
  if (track.kind === "video") return asset.kind === "video";
  return asset.kind === "audio" || asset.has_audio;
}

export function linkedClips(project: EditorialProject, clipId: string | null): TimelineClip[] {
  const clip = getClip(project, clipId);
  if (!clip) return [];
  if (!clip.linked_group_id) return [clip];
  const clips = project.clips.filter((item) => item.linked_group_id === clip.linked_group_id);
  return clips.length ? clips : [clip];
}

export function upsertClips(project: EditorialProject, clips: TimelineClip[]): EditorialProject {
  if (!clips.length) return project;
  const replacements = new Map(clips.map((clip) => [clip.id, clip]));
  const presentIds = new Set(project.clips.map((clip) => clip.id));
  const nextClips = project.clips.map((clip) => replacements.get(clip.id) ?? clip);
  for (const clip of clips) {
    if (!presentIds.has(clip.id)) nextClips.push(clip);
  }
  return {
    ...project,
    clips: nextClips,
  };
}

export function upsertClip(project: EditorialProject, clip: TimelineClip): EditorialProject {
  return upsertClips(project, [clip]);
}

export function removeClip(project: EditorialProject, clipId: string): EditorialProject {
  const clips = linkedClips(project, clipId);
  const ids = new Set(clips.map((clip) => clip.id));
  return { ...project, clips: project.clips.filter((clip) => !ids.has(clip.id)) };
}

export function splitClip(project: EditorialProject, clipId: string, atTime: number): EditorialProject {
  const clip = getClip(project, clipId);
  if (!clip) return project;
  if (atTime <= clip.start + 0.02 || atTime >= clip.start + clipDuration(clip) - 0.02) {
    return project;
  }
  const linked = linkedClips(project, clipId);
  const nextLinkedGroupId = linked.length > 1 ? `link_${crypto.randomUUID()}` : clip.linked_group_id;
  const replacements = new Map<string, TimelineClip[]>();
  for (const current of linked) {
    if (atTime <= current.start + 0.02 || atTime >= current.start + clipDuration(current) - 0.02) {
      return project;
    }
    const offset = atTime - current.start;
    const left: TimelineClip = {
      ...current,
      source_out: current.source_in + offset,
    };
    const right: TimelineClip = {
      ...current,
      id: `clip_${crypto.randomUUID()}`,
      linked_group_id: nextLinkedGroupId,
      start: atTime,
      source_in: current.source_in + offset,
    };
    replacements.set(current.id, [left, right]);
  }
  return {
    ...project,
    clips: project.clips.flatMap((item) => replacements.get(item.id) ?? [item]),
  };
}

export function patchSubtitle(
  project: EditorialProject,
  subtitleId: string,
  patch: Partial<Pick<SubtitleBlock, "text" | "start" | "end">>,
): EditorialProject {
  return {
    ...project,
    captions: project.captions.map((caption) =>
      caption.id === subtitleId ? { ...caption, ...patch } : caption,
    ),
  };
}

export function setStoryLane(project: EditorialProject, laneId: string): EditorialProject {
  return {
    ...project,
    tracks: project.tracks.map((track) => {
      if (track.kind !== "audio") return track;
      return {
        ...track,
        role: (track.id === laneId ? "story" : "support") as AudioTrackRole,
      };
    }),
  };
}

export function subtitleTrack(project: EditorialProject): TimelineTrack | undefined {
  return project.tracks.find((track) => track.kind === "subtitle");
}

export function isAudioTrack(track: TimelineTrack | null): boolean {
  return track?.kind === "audio";
}

export function isSubtitleTrack(track: TimelineTrack | null): boolean {
  return track?.kind === "subtitle";
}

export function trackHeight(kind: TimelineTrackKind): number {
  switch (kind) {
    case "video":
      return 30;
    case "audio":
      return 28;
    case "subtitle":
      return 24;
  }
}
