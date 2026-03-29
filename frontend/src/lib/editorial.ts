import type {
  AudioTrackRole,
  EditorialProject,
  ProjectAsset,
  SubtitleBlock,
  TimelineClip,
  TimelineTrack,
  TimelineTrackKind,
} from "../types";

const MIN_TRACK_PAIR_COUNT = 2;
const CAPTION_TRACK_ID = "track_subtitle_1";

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

function subtitleTrackForProject(project: EditorialProject): TimelineTrack | undefined {
  const orderedTracks = sortedTracks(project);
  const videoTracks = orderedTracks.filter((track) => track.kind === "video");
  const emptyVideoTrack = videoTracks.find((track) => !project.clips.some((clip) => (
    clip.enabled && clip.track_id === track.id
  )));
  return emptyVideoTrack
    ?? videoTracks[0]
    ?? orderedTracks.find((track) => track.kind === "subtitle");
}

function replaceGeneratedSubtitlesForLane(
  project: EditorialProject,
  laneId: string,
  trackId: string,
): SubtitleBlock[] {
  const captions = project.captions.filter((caption) => (
    caption.source_lane_id !== laneId || caption.origin !== "generated"
  ));
  const lane = project.lane_transcriptions.find((item) => item.lane_id === laneId);
  if (!lane) return captions;
  for (const [segmentIndex, segment] of lane.segments.entries()) {
    if (segment.words.length > 0) {
      for (const [wordIndex, word] of segment.words.entries()) {
        captions.push({
          id: `subtitle_${laneId}_${segmentIndex.toString().padStart(4, "0")}_${wordIndex.toString().padStart(4, "0")}`,
          track_id: trackId,
          source_lane_id: laneId,
          start: word.start,
          end: Math.max(word.end, word.start + 0.02),
          text: word.text,
          origin: "generated",
          source_word_refs: [{ segment_id: segment.id, word_index: wordIndex }],
        });
      }
      continue;
    }
    captions.push({
      id: `subtitle_${laneId}_${segmentIndex.toString().padStart(4, "0")}`,
      track_id: trackId,
      source_lane_id: laneId,
      start: segment.start,
      end: Math.max(segment.end, segment.start + 0.02),
      text: segment.text,
      origin: "generated",
      source_word_refs: [],
    });
  }
  return captions;
}

export function normalizeGeneratedSubtitles(project: EditorialProject): EditorialProject {
  const subtitleTrack = subtitleTrackForProject(project);
  if (!subtitleTrack) return project;

  let captions = project.captions;
  let changed = false;
  for (const lane of project.lane_transcriptions) {
    const totalWords = lane.segments.reduce((sum, segment) => sum + segment.words.length, 0);
    if (totalWords <= 0) continue;
    const generated = captions.filter((caption) => (
      caption.source_lane_id === lane.lane_id && caption.origin === "generated"
    ));
    const isWordLevel = (
      generated.length === totalWords
      && generated.every((caption) => caption.source_word_refs.length === 1)
    );
    if (isWordLevel) continue;
    captions = replaceGeneratedSubtitlesForLane(
      { ...project, captions },
      lane.lane_id,
      subtitleTrack.id,
    );
    changed = true;
  }

  return changed ? { ...project, captions } : project;
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

export function laneContentRange(
  project: EditorialProject,
  laneId: string,
): { start: number; end: number } | null {
  const clips = trackClips(project, laneId);
  if (!clips.length) return null;
  return {
    start: Math.min(...clips.map((clip) => clip.start)),
    end: Math.max(...clips.map((clip) => clip.start + clipDuration(clip))),
  };
}

export function assetById(project: EditorialProject, assetId: string): ProjectAsset | undefined {
  return project.assets.find((asset) => asset.id === assetId);
}

function firstTrackOfKind(project: EditorialProject, kind: TimelineTrackKind): TimelineTrack | undefined {
  return sortedTracks(project).find((track) => track.kind === kind);
}

function numericSuffix(value: string): number | null {
  const match = value.match(/(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function avTracks(project: EditorialProject, kind: "video" | "audio"): TimelineTrack[] {
  return sortedTracks(project).filter((track) => track.kind === kind);
}

function trackPairNumber(project: EditorialProject, track: TimelineTrack): number {
  if (track.kind === "subtitle") return 0;
  const direct = numericSuffix(track.id) ?? numericSuffix(track.name);
  if (direct) return direct;
  const siblings = sortedTracks(project).filter((item) => item.kind === track.kind);
  const index = siblings.findIndex((item) => item.id === track.id);
  return index >= 0 ? index + 1 : 1;
}

function pairTrackOfKind(
  project: EditorialProject,
  track: TimelineTrack,
  kind: "video" | "audio",
): TimelineTrack | undefined {
  const pairNumber = trackPairNumber(project, track);
  return avTracks(project, kind).find((item) => trackPairNumber(project, item) === pairNumber);
}

export function retargetClipGroup(
  project: EditorialProject,
  clips: TimelineClip[],
  anchorClipId: string,
  targetTrackId: string,
): TimelineClip[] {
  const anchorClip = clips.find((clip) => clip.id === anchorClipId);
  if (!anchorClip) return clips;
  const anchorTrack = getTrack(project, anchorClip.track_id);
  const targetTrack = getTrack(project, targetTrackId);
  if (
    !anchorTrack
    || !targetTrack
    || anchorTrack.kind === "subtitle"
    || targetTrack.kind !== anchorTrack.kind
  ) {
    return clips;
  }
  const targetPairNumber = trackPairNumber(project, targetTrack);
  return clips.map((clip) => {
    const currentTrack = getTrack(project, clip.track_id);
    if (!currentTrack || currentTrack.kind === "subtitle") return clip;
    const nextTrack = clip.id === anchorClipId
      ? targetTrack
      : currentTrack.kind === anchorTrack.kind
        ? targetTrack
        : avTracks(project, currentTrack.kind).find((track) => trackPairNumber(project, track) === targetPairNumber) ?? currentTrack;
    return nextTrack.id === clip.track_id ? clip : { ...clip, track_id: nextTrack.id };
  });
}

function preferredAudioTrack(project: EditorialProject): TimelineTrack | undefined {
  return sortedTracks(project).find((track) => track.kind === "audio" && track.role === "story")
    ?? firstTrackOfKind(project, "audio");
}

function nextPairNumber(pairNumbers: number[]): number {
  const used = new Set(pairNumbers.filter((value) => value > 0));
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

function createGeneratedTrack(
  kind: "video" | "audio",
  pairNumber: number,
  order: number,
  role?: AudioTrackRole | null,
): TimelineTrack {
  return {
    id: `track_${kind}_${pairNumber}`,
    kind,
    name: `${kind === "video" ? "Video" : "Audio"} ${pairNumber}`,
    order,
    visible: true,
    muted: false,
    locked: false,
    auto_generated: true,
    role: kind === "audio" ? (role ?? "support") : null,
  };
}

export function normalizeTrackLayout(project: EditorialProject): EditorialProject {
  const legacyCaptionTrack = sortedTracks(project).find((track) => track.id === CAPTION_TRACK_ID || track.kind === "subtitle");
  const existingPairs = [
    ...new Set(
      sortedTracks(project)
        .filter((track) => (
          track.kind === "video" || track.kind === "audio"
        ) && track.id !== CAPTION_TRACK_ID)
        .map((track) => trackPairNumber(project, track))
        .filter((value) => value > 0),
    ),
  ].sort((a, b) => a - b);
  const pairNumbers = [...existingPairs];
  while (pairNumbers.length < MIN_TRACK_PAIR_COUNT) pairNumbers.push(nextPairNumber(pairNumbers));

  const tracksByPair = new Map<number, { video?: TimelineTrack; audio?: TimelineTrack }>();
  for (const track of sortedTracks(project)) {
    if ((track.kind !== "video" && track.kind !== "audio") || track.id === CAPTION_TRACK_ID) continue;
    const pairNumber = trackPairNumber(project, track);
    const entry = tracksByPair.get(pairNumber) ?? {};
    if (track.kind === "video") entry.video = track;
    else entry.audio = track;
    tracksByPair.set(pairNumber, entry);
  }

  const occupiedPairs = new Set<number>();
  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  for (const clip of project.clips) {
    if (!clip.enabled) continue;
    const track = tracksById.get(clip.track_id);
    if (!track || (track.kind !== "video" && track.kind !== "audio")) continue;
    occupiedPairs.add(trackPairNumber(project, track));
  }
  if (pairNumbers.length > 0 && pairNumbers.every((pairNumber) => occupiedPairs.has(pairNumber))) {
    pairNumbers.push(nextPairNumber(pairNumbers));
  }

  let hasStoryLane = false;
  const sortedPairNumbers = [...pairNumbers].sort((a, b) => a - b);
  const nextVideoTracks: TimelineTrack[] = [];
  const nextAudioTracks: TimelineTrack[] = [];
  for (const pairNumber of sortedPairNumbers) {
    const existingPair = tracksByPair.get(pairNumber);
    const videoTrack = existingPair?.video ?? createGeneratedTrack("video", pairNumber, 0);
    const audioTrack = existingPair?.audio
      ?? createGeneratedTrack("audio", pairNumber, 0, hasStoryLane ? "support" : "story");
    const nextAudioRole = audioTrack.role === "story"
      ? (hasStoryLane ? "support" : "story")
      : (audioTrack.role ?? "support");
    if (nextAudioRole === "story") hasStoryLane = true;
    nextVideoTracks.push({
      ...videoTrack,
      name: `Video ${pairNumber}`,
      order: 0,
      role: null,
    });
    nextAudioTracks.push({
      ...audioTrack,
      name: `Audio ${pairNumber}`,
      order: 0,
      role: nextAudioRole,
    });
  }
  const nextTracks: TimelineTrack[] = [
    ...[...nextVideoTracks.reverse(), ...nextAudioTracks].map((track, index) => ({
      ...track,
      order: index,
    })),
  ];
  const hostTrackId = subtitleTrackForProject({
    ...project,
    tracks: nextTracks,
    captions: project.captions,
  })?.id ?? null;
  const nextCaptions = hostTrackId
    ? project.captions.map((caption) => {
      if (caption.track_id === hostTrackId) return caption;
      if (caption.track_id === CAPTION_TRACK_ID || caption.track_id === legacyCaptionTrack?.id) {
        return { ...caption, track_id: hostTrackId };
      }
      return caption;
    })
    : project.captions;
  if (!hasStoryLane) {
    const firstAudio = nextTracks.find((track) => track.kind === "audio");
    if (firstAudio) firstAudio.role = "story";
  }
  return {
    ...project,
    tracks: nextTracks,
    captions: nextCaptions,
    selection: {
      ...project.selection,
      track_id:
        project.selection.track_id === CAPTION_TRACK_ID
        || project.selection.track_id === legacyCaptionTrack?.id
          ? hostTrackId
          : project.selection.track_id,
    },
  };
}

export function normalizeEditorialProject(project: EditorialProject): EditorialProject {
  return normalizeTrackLayout(normalizeGeneratedSubtitles(project));
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

  const videoTrack = track.kind === "video"
    ? track
    : pairTrackOfKind(project, track, "video") ?? firstTrackOfKind(project, "video");
  const audioTrack = track.kind === "audio"
    ? track
    : pairTrackOfKind(project, track, "audio") ?? preferredAudioTrack(project);
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
  return normalizeTrackLayout({
    ...project,
    clips: nextClips,
  });
}

export function upsertClip(project: EditorialProject, clip: TimelineClip): EditorialProject {
  return upsertClips(project, [clip]);
}

export function removeClip(project: EditorialProject, clipId: string): EditorialProject {
  const clips = linkedClips(project, clipId);
  const ids = new Set(clips.map((clip) => clip.id));
  return normalizeTrackLayout({ ...project, clips: project.clips.filter((clip) => !ids.has(clip.id)) });
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
  return normalizeTrackLayout({
    ...project,
    clips: project.clips.flatMap((item) => replacements.get(item.id) ?? [item]),
  });
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
  return subtitleTrackForProject(project);
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
      return 52;
    case "audio":
      return 47;
    case "subtitle":
      return 39;
  }
}
