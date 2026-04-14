import type {
  ClipTransform,
  EditorialProject,
  TimelineClip,
} from "../../types";
import {
  assetById,
  getTrack,
  mediaPathForClip,
  projectDuration,
  sortedTracks,
} from "../editorial";

export interface MonitorSequenceSpec {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  background: string;
}

export interface MonitorVideoLayer {
  id: string;
  clipId: string;
  assetId: string;
  mediaPath: string;
  variant: TimelineClip["asset_variant"];
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  zIndex: number;
  trackOrder: number;
  transform: ClipTransform;
  sourceWidth: number;
  sourceHeight: number;
}

export interface MonitorAudioClip {
  id: string;
  clipId: string;
  assetId: string;
  mediaPath: string;
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  gain: number;
  trackOrder: number;
}

export interface MonitorComposition {
  revisionKey: string;
  duration: number;
  sequence: MonitorSequenceSpec;
  videoLayers: MonitorVideoLayer[];
  audioClips: MonitorAudioClip[];
}

function clipDuration(clip: Pick<TimelineClip, "source_in" | "source_out">): number {
  return Math.max(0, clip.source_out - clip.source_in);
}

function isActiveAtTime(
  item: Pick<MonitorVideoLayer, "start" | "end"> | Pick<MonitorAudioClip, "start" | "end">,
  time: number,
): boolean {
  return item.start <= time && time < item.end;
}

function videoLayerDrawOrder(left: MonitorVideoLayer, right: MonitorVideoLayer): number {
  return (right.trackOrder - left.trackOrder)
    || (left.zIndex - right.zIndex)
    || (left.start - right.start)
    || left.id.localeCompare(right.id);
}

function audioClipScheduleOrder(left: MonitorAudioClip, right: MonitorAudioClip): number {
  return (left.start - right.start)
    || (left.trackOrder - right.trackOrder)
    || left.id.localeCompare(right.id);
}

export function compileMonitorComposition(project: EditorialProject): MonitorComposition {
  const trackOrder = new Map(sortedTracks(project).map((track) => [track.id, track.order]));
  const videoLayers: MonitorVideoLayer[] = [];
  const audioClips: MonitorAudioClip[] = [];

  for (const clip of project.clips) {
    if (!clip.enabled) continue;
    const track = getTrack(project, clip.track_id);
    const asset = assetById(project, clip.asset_id);
    const mediaPath = mediaPathForClip(project, clip);
    if (!track || !asset || !mediaPath) continue;

    const duration = clipDuration(clip);
    if (duration <= 0) continue;
    const end = clip.start + duration;

    if (track.kind === "video" && track.visible) {
      videoLayers.push({
        id: clip.id,
        clipId: clip.id,
        assetId: clip.asset_id,
        mediaPath,
        variant: clip.asset_variant,
        start: clip.start,
        end,
        sourceIn: clip.source_in,
        sourceOut: clip.source_out,
        zIndex: clip.z_index,
        trackOrder: trackOrder.get(track.id) ?? track.order,
        transform: clip.transform,
        sourceWidth: Math.max(1, Math.round(asset.width || project.sequence.width || 1)),
        sourceHeight: Math.max(1, Math.round(asset.height || project.sequence.height || 1)),
      });
    }

    if (track.kind === "audio" && !track.muted && !clip.audio.muted && (asset.kind === "audio" || asset.has_audio)) {
      audioClips.push({
        id: clip.id,
        clipId: clip.id,
        assetId: clip.asset_id,
        mediaPath,
        start: clip.start,
        end,
        sourceIn: clip.source_in,
        sourceOut: clip.source_out,
        gain: Math.max(0, clip.audio.gain),
        trackOrder: trackOrder.get(track.id) ?? track.order,
      });
    }
  }

  videoLayers.sort(videoLayerDrawOrder);
  audioClips.sort(audioClipScheduleOrder);

  return {
    revisionKey: `${project.revision}:${project.updated_at ?? ""}:${videoLayers.length}:${audioClips.length}`,
    duration: Math.max(0, projectDuration(project)),
    sequence: {
      width: Math.max(1, Math.round(project.sequence.width || 1)),
      height: Math.max(1, Math.round(project.sequence.height || 1)),
      fps: Math.max(1, project.sequence.fps || 30),
      sampleRate: Math.max(1, project.sequence.sample_rate || 48000),
      background: project.sequence.background || "#000000",
    },
    videoLayers,
    audioClips,
  };
}

export function activeVideoLayersAtTime(
  composition: MonitorComposition,
  time: number,
): MonitorVideoLayer[] {
  return composition.videoLayers.filter((layer) => isActiveAtTime(layer, time));
}

export function activeAudioClipsAtTime(
  composition: MonitorComposition,
  time: number,
): MonitorAudioClip[] {
  return composition.audioClips.filter((clip) => isActiveAtTime(clip, time));
}

export function audioClipsStartingFrom(
  composition: MonitorComposition,
  time: number,
): MonitorAudioClip[] {
  return composition.audioClips.filter((clip) => clip.end > time);
}

export function clipLocalTime(
  clip: Pick<MonitorVideoLayer, "start" | "sourceIn"> | Pick<MonitorAudioClip, "start" | "sourceIn">,
  timelineTime: number,
): number {
  return clip.sourceIn + Math.max(0, timelineTime - clip.start);
}
