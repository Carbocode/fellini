import type {
  AssetTranscription,
  AssetTranscriptionWord,
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
const MIN_SUBTITLE_DURATION = 0.02;

function clipDuration(clip: Pick<TimelineClip, "source_in" | "source_out">): number {
  return Math.max(0, clip.source_out - clip.source_in);
}

export function projectDuration(project: EditorialProject): number {
  const clipEnd = project.clips.reduce(
    (max, clip) => Math.max(max, clip.start + clipDuration(clip)),
    0,
  );
  const subtitleEnd = visibleTimelineCaptions(project).reduce(
    (max, caption) => Math.max(max, caption.end),
    0,
  );
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

function clipContainsTime(clip: TimelineClip, time: number): boolean {
  return clip.start <= time && time <= clip.start + clipDuration(clip);
}

function clipIntersectsRange(clip: TimelineClip, start: number, end: number): boolean {
  return clip.start < end && (clip.start + clipDuration(clip)) > start;
}

function clipForLaneRange(
  laneClips: TimelineClip[],
  start: number,
  end: number,
): TimelineClip | null {
  const midpoint = start + ((end - start) / 2);
  return laneClips.find((clip) => clipContainsTime(clip, midpoint))
    ?? laneClips.find((clip) => clipIntersectsRange(clip, start, end))
    ?? null;
}

function assetWordId(assetId: string, start: number, end: number, text: string): string {
  const startMs = Math.round(Math.max(0, start) * 1000);
  const endMs = Math.round(Math.max(start, end) * 1000);
  const slug = [...text.toLowerCase()].filter((char) => /[a-z0-9]/.test(char)).join("").slice(0, 24) || "word";
  return `asset_word_${assetId}_${startMs.toString().padStart(8, "0")}_${endMs.toString().padStart(8, "0")}_${slug}`;
}

function assetWordFromLaneRange(
  clip: TimelineClip,
  text: string,
  start: number,
  end: number,
  sourceWordRefs: SubtitleBlock["source_word_refs"],
): AssetTranscriptionWord {
  const assetStart = Math.max(0, clip.source_in + (start - clip.start));
  const assetEnd = Math.max(assetStart + 0.02, clip.source_in + (end - clip.start));
  return {
    id: assetWordId(clip.asset_id, assetStart, assetEnd, text),
    start: assetStart,
    end: assetEnd,
    text,
    source_word_refs: sourceWordRefs,
  };
}

function rangesIntersect(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function fallbackAssetForLaneTranscription(project: EditorialProject): ProjectAsset | undefined {
  return project.assets.find((asset) => asset.has_audio);
}

function mergeAssetTranscriptionsFromLane(project: EditorialProject, laneId: string): EditorialProject {
  const lane = project.lane_transcriptions.find((item) => item.lane_id === laneId);
  if (!lane || !lane.segments.length) return project;
  const laneClips = trackClips(project, laneId);
  const fallbackAsset = laneClips.length ? undefined : fallbackAssetForLaneTranscription(project);
  if (!laneClips.length && !fallbackAsset) return project;

  const nextWordsByAsset = new Map<string, Map<string, AssetTranscriptionWord>>();
  const touchedRangesByAsset = new Map<string, Array<{ start: number; end: number }>>();
  for (const [segmentIndex, segment] of lane.segments.entries()) {
    if (segment.words.length > 0) {
      for (const [wordIndex, word] of segment.words.entries()) {
        const wordEnd = Math.max(word.end, word.start + 0.02);
        const ownerClip = clipForLaneRange(laneClips, word.start, wordEnd);
        if (!ownerClip && fallbackAsset) {
          const assetWord = {
            id: assetWordId(fallbackAsset.id, word.start, wordEnd, word.text),
            start: word.start,
            end: wordEnd,
            text: word.text,
            source_word_refs: [{ segment_id: segment.id, word_index: wordIndex }],
          } satisfies AssetTranscriptionWord;
          if (!nextWordsByAsset.has(fallbackAsset.id)) nextWordsByAsset.set(fallbackAsset.id, new Map());
          nextWordsByAsset.get(fallbackAsset.id)!.set(assetWord.id, assetWord);
          if (!touchedRangesByAsset.has(fallbackAsset.id)) touchedRangesByAsset.set(fallbackAsset.id, []);
          touchedRangesByAsset.get(fallbackAsset.id)!.push({ start: assetWord.start, end: assetWord.end });
          continue;
        }
        if (!ownerClip) continue;
        const assetWord = assetWordFromLaneRange(
          ownerClip,
          word.text,
          word.start,
          wordEnd,
          [{ segment_id: segment.id, word_index: wordIndex }],
        );
        if (!nextWordsByAsset.has(ownerClip.asset_id)) nextWordsByAsset.set(ownerClip.asset_id, new Map());
        nextWordsByAsset.get(ownerClip.asset_id)!.set(assetWord.id, assetWord);
        if (!touchedRangesByAsset.has(ownerClip.asset_id)) touchedRangesByAsset.set(ownerClip.asset_id, []);
        touchedRangesByAsset.get(ownerClip.asset_id)!.push({ start: assetWord.start, end: assetWord.end });
      }
      continue;
    }
    const segmentEnd = Math.max(segment.end, segment.start + 0.02);
    const ownerClip = clipForLaneRange(laneClips, segment.start, segmentEnd);
    if (!ownerClip && fallbackAsset) {
      const assetWord = {
        id: assetWordId(fallbackAsset.id, segment.start, segmentEnd, segment.text),
        start: segment.start,
        end: segmentEnd,
        text: segment.text,
        source_word_refs: [{ segment_id: segment.id, word_index: segmentIndex }],
      } satisfies AssetTranscriptionWord;
      if (!nextWordsByAsset.has(fallbackAsset.id)) nextWordsByAsset.set(fallbackAsset.id, new Map());
      nextWordsByAsset.get(fallbackAsset.id)!.set(assetWord.id, assetWord);
      if (!touchedRangesByAsset.has(fallbackAsset.id)) touchedRangesByAsset.set(fallbackAsset.id, []);
      touchedRangesByAsset.get(fallbackAsset.id)!.push({ start: assetWord.start, end: assetWord.end });
      continue;
    }
    if (!ownerClip) continue;
    const assetWord = assetWordFromLaneRange(
      ownerClip,
      segment.text,
      segment.start,
      segmentEnd,
      [{ segment_id: segment.id, word_index: segmentIndex }],
    );
    if (!nextWordsByAsset.has(ownerClip.asset_id)) nextWordsByAsset.set(ownerClip.asset_id, new Map());
    nextWordsByAsset.get(ownerClip.asset_id)!.set(assetWord.id, assetWord);
    if (!touchedRangesByAsset.has(ownerClip.asset_id)) touchedRangesByAsset.set(ownerClip.asset_id, []);
    touchedRangesByAsset.get(ownerClip.asset_id)!.push({ start: assetWord.start, end: assetWord.end });
  }

  if (!nextWordsByAsset.size) return project;

  const existingByAsset = new Map(project.asset_transcriptions.map((item) => [item.asset_id, item]));
  const updatedAssetTranscriptions: AssetTranscription[] = [];
  for (const item of project.asset_transcriptions) {
    const nextWords = nextWordsByAsset.get(item.asset_id);
    if (!nextWords) {
      updatedAssetTranscriptions.push(item);
      continue;
    }
    const touchedRanges = touchedRangesByAsset.get(item.asset_id) ?? [];
    const preservedWords = item.words.filter((word) => !touchedRanges.some((range) => (
      rangesIntersect(word.start, word.end, range.start, range.end)
    )));
    updatedAssetTranscriptions.push({
      ...item,
      language: lane.language,
      words: [...preservedWords, ...nextWords.values()].sort((a, b) => (
        (a.start - b.start) || (a.end - b.end) || a.text.localeCompare(b.text) || a.id.localeCompare(b.id)
      )),
      source_lane_id: laneId,
      source_audio_path: lane.source_audio_path,
      updated_at: new Date().toISOString(),
      error: null,
    });
  }
  for (const [assetId, words] of nextWordsByAsset.entries()) {
    if (existingByAsset.has(assetId)) continue;
    updatedAssetTranscriptions.push({
      asset_id: assetId,
      language: lane.language,
      words: [...words.values()].sort((a, b) => (
        (a.start - b.start) || (a.end - b.end) || a.text.localeCompare(b.text) || a.id.localeCompare(b.id)
      )),
      source_lane_id: laneId,
      source_audio_path: lane.source_audio_path,
      updated_at: new Date().toISOString(),
      error: null,
    });
  }

  return {
    ...project,
    assets: project.assets.map((asset) => (
      nextWordsByAsset.has(asset.id)
        ? { ...asset, transcript_ref: asset.id }
        : asset
    )),
    asset_transcriptions: updatedAssetTranscriptions,
  };
}

function materializedGeneratedSubtitles(project: EditorialProject, subtitleTrackId: string): SubtitleBlock[] {
  const wordsByAsset = new Map(project.asset_transcriptions.map((item) => [item.asset_id, item.words]));
  const clipCaptions = project.clips
    .filter((clip) => {
      const track = getTrack(project, clip.track_id);
      return clip.enabled && clip.captions_enabled && track?.kind === "audio";
    })
    .sort((a, b) => (a.start - b.start) || a.id.localeCompare(b.id))
    .flatMap((clip) => (
      (wordsByAsset.get(clip.asset_id) ?? [])
        .filter((word) => word.end > clip.source_in && word.start < clip.source_out)
        .map((word) => {
          const visibleStart = Math.max(word.start, clip.source_in);
          const visibleEnd = Math.min(word.end, clip.source_out);
          const start = clip.start + (visibleStart - clip.source_in);
          const end = clip.start + (visibleEnd - clip.source_in);
          return {
            id: `subtitle_${clip.id}_${word.id}`,
            track_id: subtitleTrackId,
            source_lane_id: clip.track_id,
            source_clip_id: clip.id,
            source_asset_id: clip.asset_id,
            source_asset_start: word.start,
            source_asset_end: word.end,
            start,
            end: Math.max(start + 0.02, end),
            text: word.text,
            origin: "generated" as const,
            source_word_refs: [...word.source_word_refs],
          } satisfies SubtitleBlock;
        })
    ))
    .sort((a, b) => (a.start - b.start) || (a.end - b.end) || a.id.localeCompare(b.id));
  const materializedAssets = new Set(clipCaptions.map((caption) => caption.source_asset_id).filter(Boolean));
  const fallbackLaneId = sortedTracks(project).find((track) => track.kind === "audio")?.id ?? subtitleTrackId;
  const standaloneCaptions = project.asset_transcriptions
    .filter((transcription) => !materializedAssets.has(transcription.asset_id))
    .flatMap((transcription) => transcription.words.map((word) => ({
      id: `subtitle_standalone_${transcription.asset_id}_${word.id}`,
      track_id: subtitleTrackId,
      source_lane_id: transcription.source_lane_id ?? fallbackLaneId,
      source_clip_id: null,
      source_asset_id: transcription.asset_id,
      source_asset_start: word.start,
      source_asset_end: word.end,
      start: word.start,
      end: Math.max(word.start + 0.02, word.end),
      text: word.text,
      origin: "generated" as const,
      source_word_refs: [...word.source_word_refs],
    } satisfies SubtitleBlock)));
  return [...clipCaptions, ...standaloneCaptions]
    .sort((a, b) => (a.start - b.start) || (a.end - b.end) || a.id.localeCompare(b.id));
}

export function normalizeGeneratedSubtitles(project: EditorialProject): EditorialProject {
  const subtitleTrack = subtitleTrackForProject(project);
  if (!subtitleTrack) return project;

  let updated = project;
  const hasStructuralGenerated = updated.asset_transcriptions.length > 0 || updated.captions.some((caption) => (
    caption.origin === "generated" && !!caption.source_asset_id
  ));
  if (!hasStructuralGenerated) {
    for (const lane of updated.lane_transcriptions) {
      if (!lane.segments.length) continue;
      updated = mergeAssetTranscriptionsFromLane(updated, lane.lane_id);
    }
  }

  const manualCaptions = updated.captions.filter((caption) => caption.origin !== "generated");
  const legacyGeneratedCaptions = updated.captions.filter((caption) => (
    caption.origin === "generated" && !caption.source_asset_id
  ));
  const generatedCaptions = materializedGeneratedSubtitles(updated, subtitleTrack.id);
  if (
    manualCaptions.length === updated.captions.length
    && !generatedCaptions.length
    && updated === project
  ) {
    return project;
  }
  return {
    ...updated,
    captions: [
      ...manualCaptions,
      ...(updated.asset_transcriptions.length ? [] : legacyGeneratedCaptions),
      ...generatedCaptions,
    ],
  };
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
  return visibleTimelineCaptions(project)
    .filter((caption) => caption.track_id === trackId)
    .sort((a, b) => a.start - b.start);
}

export interface SubtitleVisualGroup {
  id: string;
  sourceLaneId: string;
  sourceClipId: string | null;
  assetId: string | null;
  linkedGroupId: string | null;
  start: number;
  end: number;
  captions: SubtitleBlock[];
  isFallback: boolean;
}

export function visibleTimelineCaptions(project: EditorialProject): SubtitleBlock[] {
  return project.captions.filter((caption) => (
    caption.origin !== "generated"
    || !caption.source_clip_id
    || !!getClip(project, caption.source_clip_id)
  ));
}

export function generatedSubtitleGroupsForLane(
  project: EditorialProject,
  laneId: string,
): SubtitleVisualGroup[] {
  const laneCaptions = visibleTimelineCaptions(project)
    .filter((caption) => caption.source_lane_id === laneId && caption.origin === "generated")
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const grouped = new Map<string, { clip: TimelineClip | null; captions: SubtitleBlock[] }>();
  for (const caption of laneCaptions) {
    const ownerClip = caption.source_clip_id ? getClip(project, caption.source_clip_id) : null;
    const key = ownerClip?.id ?? `standalone:${caption.id}`;
    const entry = grouped.get(key) ?? { clip: ownerClip, captions: [] };
    entry.captions.push(caption);
    grouped.set(key, entry);
  }

  return [...grouped.entries()]
    .map(([key, entry]) => {
      const captions = [...entry.captions].sort((a, b) => (a.start - b.start) || (a.end - b.end));
      const visualStart = entry.clip?.start ?? Math.min(...captions.map((caption) => caption.start));
      const visualEnd = entry.clip
        ? entry.clip.start + clipDuration(entry.clip)
        : Math.max(...captions.map((caption) => caption.end));
      return {
        id: `subtitle_group_${laneId}_${key}`,
        sourceLaneId: laneId,
        sourceClipId: entry.clip?.id ?? null,
        assetId: entry.clip?.asset_id ?? null,
        linkedGroupId: entry.clip?.linked_group_id ?? null,
        start: visualStart,
        end: visualEnd,
        captions,
        isFallback: !entry.clip,
      } satisfies SubtitleVisualGroup;
    })
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
}

export function syncGeneratedSubtitlesWithMovedAudioClips(
  _previousProject: EditorialProject,
  nextProject: EditorialProject,
  _clipIds: string[],
): EditorialProject {
  return nextProject;
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

export function removeSubtitle(project: EditorialProject, subtitleId: string): EditorialProject {
  const target = getSubtitleBlock(project, subtitleId);
  if (!target) return project;

  if (target.origin === "generated" && target.source_asset_id) {
    return {
      ...project,
      asset_transcriptions: project.asset_transcriptions.map((transcription) => {
        if (transcription.asset_id !== target.source_asset_id) return transcription;
        return {
          ...transcription,
          words: transcription.words.filter((word) => !(
            word.start === (target.source_asset_start ?? word.start)
            && word.end === (target.source_asset_end ?? word.end)
            && word.text === target.text
          )),
        };
      }),
    };
  }

  return {
    ...project,
    captions: project.captions.filter((caption) => caption.id !== subtitleId),
  };
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
  const target = getSubtitleBlock(project, subtitleId);
  if (target?.origin === "generated" && target.source_asset_id) {
    const ownerClip = target.source_clip_id ? getClip(project, target.source_clip_id) : null;
    const nextAssetStart = patch.start !== undefined
      ? ownerClip
        ? Math.max(0, ownerClip.source_in + (patch.start - ownerClip.start))
        : Math.max(0, patch.start)
      : target.source_asset_start ?? null;
    const nextAssetEnd = patch.end !== undefined
      ? ownerClip
        ? Math.max(
            (nextAssetStart ?? 0) + MIN_SUBTITLE_DURATION,
            ownerClip.source_in + (patch.end - ownerClip.start),
          )
        : Math.max(
            (nextAssetStart ?? target.source_asset_start ?? Math.max(0, patch.end - MIN_SUBTITLE_DURATION))
              + MIN_SUBTITLE_DURATION,
            patch.end,
          )
      : target.source_asset_end ?? null;
    return {
      ...project,
      asset_transcriptions: project.asset_transcriptions.map((transcription) => {
        if (transcription.asset_id !== target.source_asset_id) return transcription;
        return {
          ...transcription,
          words: transcription.words.map((word) => {
            const matches = (
              word.start === (target.source_asset_start ?? word.start)
              && word.end === (target.source_asset_end ?? word.end)
              && word.text === target.text
            );
            if (!matches) return word;
            return {
              ...word,
              text: patch.text ?? word.text,
              start: nextAssetStart ?? word.start,
              end: nextAssetEnd ?? word.end,
            };
          }),
        };
      }),
    };
  }
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

const TIMELINE_TRACK_HEIGHT = 64;

export function trackHeight(_kind: TimelineTrackKind): number {
  return TIMELINE_TRACK_HEIGHT;
}
