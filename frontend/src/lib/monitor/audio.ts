import type { MonitorAudioClip } from "./composition";
import type { DemuxedAudioTrack } from "./mp4";

const AUDIO_CONTEXT_START_LEAD_SECONDS = 0.03;
const AUDIO_COPY_FORMAT = "f32-planar";

type AudioFrameCopy = {
  startFrame: number;
  channelData: Float32Array[];
};

function cloneChannelPlanes(audioData: AudioData): AudioFrameCopy {
  const sampleRate = audioData.sampleRate || 48_000;
  const startFrame = Math.max(0, Math.round((audioData.timestamp / 1_000_000) * sampleRate));
  const channelData = Array.from({ length: audioData.numberOfChannels }, (_, planeIndex) => {
    const options = { planeIndex, format: AUDIO_COPY_FORMAT as AudioSampleFormat };
    const planeSize = audioData.allocationSize(options);
    const channel = new Float32Array(new ArrayBuffer(planeSize));
    audioData.copyTo(channel, options);
    return channel;
  });
  return { startFrame, channelData };
}

export async function decodeAudioTrackToAudioBuffer(
  track: DemuxedAudioTrack,
): Promise<AudioBuffer> {
  const support = await AudioDecoder.isConfigSupported({
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.numberOfChannels,
    ...(track.description ? { description: track.description } : {}),
  });
  if (!support.supported) {
    throw new Error(`Audio codec non supportato dal browser: ${track.codec}`);
  }

  const decodedFrames: AudioFrameCopy[] = [];
  let decodeError: Error | null = null;

  const decoder = new AudioDecoder({
    output: (audioData) => {
      try {
        decodedFrames.push(cloneChannelPlanes(audioData));
      } finally {
        audioData.close();
      }
    },
    error: (error) => {
      decodeError = error instanceof Error ? error : new Error(String(error));
    },
  });

  decoder.configure({
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.numberOfChannels,
    ...(track.description ? { description: track.description } : {}),
  });

  for (const sample of track.samples) {
    decoder.decode(new EncodedAudioChunk({
      type: "key",
      timestamp: sample.timestampUs,
      duration: sample.durationUs,
      data: sample.data,
    }));
  }
  await decoder.flush();
  decoder.close();

  if (decodeError) throw decodeError;
  if (!decodedFrames.length) {
    return new AudioBuffer({
      numberOfChannels: track.numberOfChannels,
      length: 1,
      sampleRate: track.sampleRate,
    });
  }

  const totalFrames = decodedFrames.reduce((max, frame) => (
    Math.max(max, frame.startFrame + (frame.channelData[0]?.length ?? 0))
  ), 0);
  const output = new AudioBuffer({
    numberOfChannels: decodedFrames[0]?.channelData.length || track.numberOfChannels,
    length: Math.max(1, totalFrames),
    sampleRate: track.sampleRate,
  });

  for (const frame of decodedFrames) {
    for (let channelIndex = 0; channelIndex < frame.channelData.length; channelIndex += 1) {
      output.getChannelData(channelIndex).set(frame.channelData[channelIndex], frame.startFrame);
    }
  }

  return output;
}

type AudioBufferProvider = (mediaUrl: string) => Promise<AudioBuffer | null>;

type ScheduledAudioNode = {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
};

export class MonitorAudioTransport {
  private context: AudioContext | null = null;
  private sessionToken = 0;
  private playing = false;
  private startContextTime = 0;
  private startTimelineTime = 0;
  private duration = 0;
  private scheduledNodes = new Map<string, ScheduledAudioNode>();

  constructor(
    private readonly getSequenceSampleRate: () => number,
    private readonly loadAudioBuffer: AudioBufferProvider,
  ) {}

  private async ensureContext(): Promise<AudioContext> {
    const sampleRate = Math.max(1, this.getSequenceSampleRate());
    if (this.context && this.context.state !== "closed" && this.context.sampleRate === sampleRate) {
      return this.context;
    }
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {});
    }
    this.context = new AudioContext({ sampleRate });
    return this.context;
  }

  private stopScheduledNodes(): void {
    for (const node of this.scheduledNodes.values()) {
      try {
        node.source.stop();
      } catch {
        // Ignore repeated stops during seek/pause.
      }
      node.source.disconnect();
      node.gainNode.disconnect();
    }
    this.scheduledNodes.clear();
  }

  private scheduleClip(
    clip: MonitorAudioClip,
    sessionToken: number,
    context: AudioContext,
  ): void {
    void this.loadAudioBuffer(clip.mediaPath).then((buffer) => {
      if (!buffer || !this.playing || sessionToken !== this.sessionToken) return;
      const clipDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
      if (clipDuration <= 0) return;

      const visibleStart = Math.max(clip.start, this.startTimelineTime);
      const visibleEnd = clip.end;
      if (visibleEnd <= visibleStart) return;

      let when = this.startContextTime + (visibleStart - this.startTimelineTime);
      let offset = clip.sourceIn + Math.max(0, visibleStart - clip.start);
      let duration = Math.min(clipDuration - (offset - clip.sourceIn), visibleEnd - visibleStart);
      if (duration <= 0) return;

      if (when < context.currentTime) {
        const lateBy = context.currentTime - when;
        offset += lateBy;
        duration -= lateBy;
        when = context.currentTime + 0.005;
      }
      if (duration <= 0) return;

      const source = context.createBufferSource();
      source.buffer = buffer;
      const gainNode = context.createGain();
      gainNode.gain.value = Math.max(0, clip.gain);
      source.connect(gainNode);
      gainNode.connect(context.destination);
      source.start(when, offset, duration);

      const nodeKey = `${sessionToken}:${clip.id}`;
      source.onended = () => {
        this.scheduledNodes.delete(nodeKey);
        source.disconnect();
        gainNode.disconnect();
      };
      this.scheduledNodes.set(nodeKey, { source, gainNode });
    }).catch(() => {
      // Skip failed audio assets in preview transport. The monitor stays responsive.
    });
  }

  getCurrentTime(): number {
    if (!this.playing || !this.context) return this.startTimelineTime;
    return Math.max(0, Math.min(
      this.duration,
      this.startTimelineTime + Math.max(0, this.context.currentTime - this.startContextTime),
    ));
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async play(clips: MonitorAudioClip[], startTime: number, duration: number): Promise<void> {
    const context = await this.ensureContext();
    this.duration = Math.max(0, duration);
    this.startTimelineTime = Math.max(0, Math.min(startTime, this.duration));
    this.stopScheduledNodes();
    this.sessionToken += 1;
    const sessionToken = this.sessionToken;
    await context.resume();
    this.startContextTime = context.currentTime + AUDIO_CONTEXT_START_LEAD_SECONDS;
    this.playing = true;
    for (const clip of clips) {
      if (clip.end <= this.startTimelineTime) continue;
      this.scheduleClip(clip, sessionToken, context);
    }
  }

  async pause(): Promise<number> {
    const currentTime = this.getCurrentTime();
    this.playing = false;
    this.startTimelineTime = currentTime;
    this.stopScheduledNodes();
    if (this.context && this.context.state === "running") {
      await this.context.suspend().catch(() => {});
    }
    return currentTime;
  }

  async seek(time: number, clips: MonitorAudioClip[], duration: number): Promise<void> {
    this.duration = Math.max(0, duration);
    this.startTimelineTime = Math.max(0, Math.min(time, this.duration));
    if (!this.playing) return;
    await this.play(clips, this.startTimelineTime, this.duration);
  }

  async destroy(): Promise<void> {
    this.playing = false;
    this.stopScheduledNodes();
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {});
    }
    this.context = null;
  }
}
