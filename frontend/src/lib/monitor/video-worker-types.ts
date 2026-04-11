import type { DemuxedVideoTrack } from "./mp4";

export type DecoderAccelerationPreference =
  | "prefer-hardware"
  | "no-preference"
  | "prefer-software";

export type VideoDecoderWorkerCommand =
  | {
    type: "init";
    track: DemuxedVideoTrack;
    targetUs: number;
    playing: boolean;
  }
  | {
    type: "update-target";
    targetUs: number;
    playing: boolean;
    forceSeek: boolean;
  }
  | {
    type: "dispose";
  };

export type VideoDecoderWorkerEvent =
  | {
    type: "ready";
    acceleration: DecoderAccelerationPreference | null;
  }
  | {
    type: "frame";
    timestampUs: number;
    durationUs: number;
    frame: VideoFrame;
  }
  | {
    type: "error";
    message: string;
  };
