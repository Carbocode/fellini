import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, type Accessor, type Component } from "solid-js";
import {
  IconArrowsMoveHorizontal,
  IconCrop,
  IconMovie,
  IconScissors,
  IconStack2,
  IconVideo,
  IconWaveSquare,
} from "@tabler/icons-solidjs";
import {
  selectedJobId,
  selectedClipId,
  selectedSubtitleId,
  selectedTrackId,
  setSelectedSubtitleId,
} from "../store";
import type { ClipCrop, ClipTranscriptionOptions, ClipTransform, EditorialProject } from "../types";
import {
  useJobQuery,
  useStartBackgroundRemovalMutation,
  useTranscribeClipMutation,
} from "../api/queries";
import {
  assetById,
  getClip,
  getSubtitleBlock,
  getTrack,
  patchSubtitle,
  removeSubtitle,
  setStoryLane,
  trackClips,
} from "../lib/editorial";
import { baseName, fmtTimePrecise } from "../lib/utils";
import {
  Button,
  FormField,
  InfoRow,
  Input,
  Select,
  Textarea,
  Toggle,
  DragNumber,
  JoystickPad,
  InspectorAccordion,
} from "./ui";

const ASR_LANGUAGE_OPTIONS = [
  { value: "it" },
  { value: "en" },
  { value: "es" },
  { value: "fr" },
  { value: "de" },
  { value: "pt" },
  { value: "nl" },
];

const ASR_MODEL_OPTIONS = [
  { value: "large-v3", label: "large-v3" },
  { value: "distil-large-v3", label: "distil-large-v3" },
  { value: "medium", label: "medium" },
  { value: "medium.en", label: "medium.en" },
  { value: "small", label: "small" },
  { value: "small.en", label: "small.en" },
  { value: "base", label: "base" },
  { value: "base.en", label: "base.en" },
  { value: "tiny", label: "tiny" },
  { value: "tiny.en", label: "tiny.en" },
];

type InspectorTab = "video" | "lane" | "audio" | "file";

const ParamsInspector: Component<{
  project: Accessor<EditorialProject | null>;
  updateProject: (next: EditorialProject | ((current: EditorialProject) => EditorialProject)) => void;
}> = (props) => {
  const job = useJobQuery(selectedJobId);
  const startBackgroundRemoval = useStartBackgroundRemovalMutation();
  const transcribeClip = useTranscribeClipMutation();
  const [activeTab, setActiveTab] = createSignal<InspectorTab>("lane");
  const currentTrack = createMemo(() => {
    const project = props.project();
    const clip = project ? getClip(project, selectedClipId()) : null;
    if (project && clip) return getTrack(project, clip.track_id) ?? null;
    return project ? getTrack(project, selectedTrackId()) : null;
  });
  const currentClip = createMemo(() => {
    const project = props.project();
    return project ? getClip(project, selectedClipId()) : null;
  });
  const currentSubtitle = createMemo(() => {
    const project = props.project();
    return project ? getSubtitleBlock(project, selectedSubtitleId()) : null;
  });
  const currentAsset = createMemo(() => {
    const project = props.project();
    const clip = currentClip();
    return project && clip ? assetById(project, clip.asset_id) ?? null : null;
  });
  const backgroundRemoval = createMemo(() => currentAsset()?.background_removal ?? null);
  const currentClipTranscriptionWords = createMemo(() => {
    const project = props.project();
    const clip = currentClip();
    if (!project || !clip) return [];
    const transcription = project.asset_transcriptions.find((item) => item.asset_id === clip.asset_id);
    if (!transcription) return [];
    return transcription.words
      .filter((word) => word.end > clip.source_in && word.start < clip.source_out)
      .sort((left, right) => (left.start - right.start) || (left.end - right.end) || left.id.localeCompare(right.id));
  });
  const currentClipTranscriptionWordCount = createMemo(() => currentClipTranscriptionWords().length);
  const currentTranscriptionStep = createMemo(() =>
    (job.data?.steps ?? []).find((step) => step.name === "transcription") ?? null
  );
  const currentClipTranscriptPreview = createMemo(() =>
    currentClipTranscriptionWords().map((word) => word.text).join(" ").trim()
  );
  const effectiveClipLanguage = createMemo(() =>
    currentClip()?.transcription_options.language?.trim() || job.data?.request.language || "it"
  );
  const effectiveClipModel = createMemo(() =>
    currentClip()?.transcription_options.model?.trim() || job.data?.request.transcription.model || "large-v3"
  );
  const effectiveClipBeamSize = createMemo(() =>
    currentClip()?.transcription_options.beam_size ?? job.data?.request.transcription.beam_size ?? 5
  );
  const effectiveClipVadFilter = createMemo(() =>
    currentClip()?.transcription_options.vad_filter ?? job.data?.request.transcription.vad_filter ?? true
  );
  const effectiveClipWhisperX = createMemo(() =>
    currentClip()?.transcription_options.use_whisperx ?? job.data?.request.toggles.use_whisperx ?? true
  );
  const updateClipTranscriptionOptions = (patch: Partial<ClipTranscriptionOptions>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) => (
        item.id === clip.id
          ? {
              ...item,
              transcription_options: {
                ...item.transcription_options,
                ...patch,
              },
            }
          : item
      )),
    }));
  };
  const updateClipTransform = (patch: Partial<ClipTransform>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) =>
        item.id === clip.id
          ? { ...item, transform: { ...item.transform, ...patch } }
          : item
      ),
    }));
  };
  const updateClipCrop = (patch: Partial<ClipCrop>) => {
    const clip = currentClip();
    if (!clip) return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) =>
        item.id === clip.id
          ? { ...item, transform: { ...item.transform, crop: { ...item.transform.crop, ...patch } } }
          : item
      ),
    }));
  };

  const deleteSelectedSubtitle = () => {
    const subtitle = currentSubtitle();
    if (!subtitle) return;
    props.updateProject((project) => removeSubtitle(project, subtitle.id));
    setSelectedSubtitleId(null);
  };
  const runBackgroundRemoval = () => {
    const jobId = selectedJobId();
    const asset = currentAsset();
    if (!jobId || !asset || asset.kind !== "video") return;
    startBackgroundRemoval.mutate({ jobId, assetId: asset.id });
  };
  const canTranscribeClip = createMemo(() => {
    const clip = currentClip();
    const asset = currentAsset();
    const track = currentTrack();
    return !!selectedJobId()
      && !!job.data
      && job.data.status !== "running"
      && !!clip
      && !!asset
      && track?.kind === "audio"
      && (asset.kind === "audio" || asset.has_audio)
      && clip.transcription_status !== "running";
  });
  const runClipTranscription = () => {
    const jobId = selectedJobId();
    const clip = currentClip();
    if (!jobId || !clip) return;
    transcribeClip.mutate({ jobId, clipId: clip.id, options: clip.transcription_options });
  };
  const clipTranscriptionButtonLabel = () => {
    const clip = currentClip();
    if (!clip) return "Trascrivi clip";
    if (clip.transcription_status === "running") return "Trascrizione in corso";
    if (clip.transcription_status === "completed") return "Rigenera sottotitoli";
    if (clip.transcription_status === "failed") return "Riprova trascrizione";
    return "Genera sottotitoli";
  };
  const setClipMaskEnabled = (maskEnabled: boolean) => {
    const clip = currentClip();
    const asset = currentAsset();
    const track = currentTrack();
    if (!clip || !asset || asset.kind !== "video" || track?.kind !== "video") return;
    props.updateProject((project) => ({
      ...project,
      clips: project.clips.map((item) => (
        item.id === clip.id
          ? { ...item, mask_enabled: maskEnabled }
          : item
      )),
    }));
  };
  const hasLaneSettings = createMemo(() => !!currentTrack() || !!currentSubtitle());
  const hasVideoSettings = createMemo(() => !!currentClip() && currentTrack()?.kind === "video");
  const hasAudioSettings = createMemo(() => !!currentClip() && currentTrack()?.kind === "audio");
  const hasFileSettings = createMemo(() => !!currentClip() && !!currentAsset());
  const preferredTab = createMemo<InspectorTab>(() => {
    if (hasAudioSettings()) return "audio";
    if (hasVideoSettings()) return "video";
    return "lane";
  });
  const isTabEnabled = (tab: InspectorTab) => (
    tab === "video" ? hasVideoSettings()
      : tab === "audio" ? hasAudioSettings()
        : tab === "file" ? hasFileSettings()
          : hasLaneSettings()
  );
  const selectTab = (tab: InspectorTab) => {
    if (!isTabEnabled(tab)) return;
    setActiveTab(tab);
  };
  createEffect(() => {
    const tab = activeTab();
    if (isTabEnabled(tab)) return;
    setActiveTab(preferredTab());
  });
  createEffect(
    on(
      () => `${selectedClipId() ?? ""}:${selectedSubtitleId() ?? ""}:${selectedTrackId() ?? ""}`,
      () => {
        if (selectedClipId()) {
          const nextTab = preferredTab();
          if (nextTab === "video" || nextTab === "audio") {
            setActiveTab(nextTab);
            return;
          }
        }
        if (selectedSubtitleId() || selectedTrackId()) setActiveTab("lane");
      },
    ),
  );

  const laneStats = createMemo(() => {
    const project = props.project();
    const track = currentTrack();
    if (!project || !track) return null;
    const clips = trackClips(project, track.id);
    const clipDurations = clips.map((clip) => Math.max(0, clip.source_out - clip.source_in));
    const totalClipDuration = clipDurations.reduce((sum, duration) => sum + duration, 0);
    const coverageStart = clips.length ? Math.min(...clips.map((clip) => clip.start)) : null;
    const coverageEnd = clips.length
      ? Math.max(...clips.map((clip) => clip.start + Math.max(0, clip.source_out - clip.source_in)))
      : null;
    const uniqueAssets = new Set(clips.map((clip) => clip.asset_id)).size;
    const linkedClips = clips.filter((clip) => clip.linked_group_id).length;
    const relatedCaptions = track.kind === "subtitle"
      ? project.captions.filter((caption) => caption.track_id === track.id)
      : project.captions.filter((caption) => caption.source_lane_id === track.id);
    const generatedCaptions = relatedCaptions.filter((caption) => caption.origin === "generated").length;
    return {
      clipCount: clips.length,
      uniqueAssets,
      totalClipDuration,
      coverageStart,
      coverageEnd,
      relatedCaptionCount: relatedCaptions.length,
      generatedCaptionCount: generatedCaptions,
      manualCaptionCount: relatedCaptions.length - generatedCaptions,
      linkedClipCount: linkedClips,
    };
  });

  const formatLaneCoverage = (start: number | null, end: number | null) =>
    start === null || end === null ? "Vuota" : `${fmtTimePrecise(start)} - ${fmtTimePrecise(end)}`;

  const renderLanePanel = () => {
    const track = currentTrack();
    const stats = laneStats();
    if (!track || !stats) return null;
    const captionLabel = track.kind === "subtitle" ? "Blocchi testo" : "Sottotitoli";
    const muteLabel = track.kind === "audio"
      ? (track.muted ? "Muted" : "Audible")
      : (track.muted ? "Muted" : "Active");
    return (
      <div class="inspector-lane-panel">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">Lane</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">{track.name}</span>
              <span class="timeline-mode-tag">{track.kind}</span>
              <Show when={track.kind === "audio" && track.role}>
                <span class={`inspector-lane-chip${track.role === "story" ? " is-story" : ""}`}>{track.role}</span>
              </Show>
            </div>
            <div class="inspector-lane-state-row">
              <span class={`inspector-lane-chip${track.visible ? " is-on" : ""}`}>{track.visible ? "Visible" : "Hidden"}</span>
              <span class={`inspector-lane-chip${track.muted ? "" : " is-on"}`}>{muteLabel}</span>
              <span class={`inspector-lane-chip${track.locked ? "" : " is-on"}`}>{track.locked ? "Locked" : "Editable"}</span>
              <Show when={track.auto_generated}>
                <span class="inspector-lane-chip">Auto</span>
              </Show>
            </div>
          </div>
          <Show when={track.kind === "audio"}>
            <Button
              variant={track.role === "story" ? "primary" : "ghost"}
              size="xs"
              onClick={() => props.updateProject((project) => setStoryLane(project, track.id))}
            >
              {track.role === "story" ? "Story lane" : "Set story"}
            </Button>
          </Show>
        </div>

        <div class="inspector-lane-stat-grid">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Clip attive</span>
            <span class="inspector-lane-stat-value">{stats.clipCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Asset unici</span>
            <span class="inspector-lane-stat-value">{stats.uniqueAssets}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata montata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(stats.totalClipDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Copertura</span>
            <span class="inspector-lane-stat-value">{formatLaneCoverage(stats.coverageStart, stats.coverageEnd)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">{captionLabel}</span>
            <span class="inspector-lane-stat-value">{stats.relatedCaptionCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Clip linked</span>
            <span class="inspector-lane-stat-value">{stats.linkedClipCount}</span>
          </div>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Dettagli</div>
          <InfoRow label="Nome" value={track.name} />
          <InfoRow label="Ordine timeline" value={track.order + 1} />
          <InfoRow label="Tipo">
            <span class="timeline-mode-tag">{track.kind}</span>
          </InfoRow>
          <Show when={track.kind === "audio" && track.role}>
            <InfoRow label="Ruolo" value={track.role} />
          </Show>
          <InfoRow label="Sottotitoli generati" value={stats.generatedCaptionCount} />
          <InfoRow label="Sottotitoli manuali" value={stats.manualCaptionCount} />
        </div>
      </div>
    );
  };

  const renderSubtitlePanel = () => {
    const subtitle = currentSubtitle();
    if (!subtitle) return null;
    const subtitleDuration = Math.max(0, subtitle.end - subtitle.start);
    const wordCount = subtitle.text.trim() ? subtitle.text.trim().split(/\s+/).length : 0;
    return (
      <div class="inspector-lane-panel inspector-lane-panel--secondary">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">Sottotitolo</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">Blocco selezionato</span>
              <span class="timeline-mode-tag">text</span>
            </div>
            <div class="inspector-lane-meta">
              {fmtTimePrecise(subtitle.start)} - {fmtTimePrecise(subtitle.end)}
            </div>
          </div>
        </div>

        <div class="inspector-lane-stat-grid inspector-lane-stat-grid--compact">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(subtitleDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Parole</span>
            <span class="inspector-lane-stat-value">{wordCount}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Word refs</span>
            <span class="inspector-lane-stat-value">{subtitle.source_word_refs.length}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Origine</span>
            <span class="inspector-lane-stat-value">{subtitle.origin}</span>
          </div>
        </div>

        <FormField label="Testo" variant="compact">
          <Textarea
            value={subtitle.text}
            onInput={(e) =>
              props.updateProject((project) =>
                patchSubtitle(project, subtitle.id, { text: e.currentTarget.value })
              )}
          />
        </FormField>
        <div class="inspector-lane-field-row">
          <FormField label="Start" variant="compact">
            <Input
              type="number"
              step="0.01"
              value={subtitle.start}
              onInput={(e) =>
                props.updateProject((project) =>
                  patchSubtitle(project, subtitle.id, { start: Number(e.currentTarget.value) })
                )}
            />
          </FormField>
          <FormField label="End" variant="compact">
            <Input
              type="number"
              step="0.01"
              value={subtitle.end}
              onInput={(e) =>
                props.updateProject((project) =>
                  patchSubtitle(project, subtitle.id, { end: Number(e.currentTarget.value) })
                )}
            />
          </FormField>
        </div>
        <div class="inspector-card-actions">
          <Button variant="danger" size="xs" onClick={deleteSelectedSubtitle}>
            Elimina blocco
          </Button>
        </div>
      </div>
    );
  };

  const renderFilePanel = () => {
    const clip = currentClip();
    const asset = currentAsset();
    if (!clip || !asset) return null;
    const usedDuration = Math.max(0, clip.source_out - clip.source_in);
    const clipEnd = clip.start + usedDuration;
    const resolution = asset.width > 0 && asset.height > 0 ? `${asset.width} x ${asset.height}` : "n/a";
    const sampleRate = asset.sample_rate ? `${(asset.sample_rate / 1000).toFixed(asset.sample_rate % 1000 === 0 ? 0 : 1)} kHz` : "n/a";
    const fps = asset.fps > 0 ? asset.fps.toFixed(asset.fps % 1 === 0 ? 0 : 2) : "n/a";
    const previewReady = asset.preview?.original || asset.preview?.mask ? "Available" : "Missing";
    const clipMaskState = clip.mask_enabled ? "Enabled" : "Disabled";
    return (
      <div class="inspector-lane-panel">
        <div class="inspector-lane-head">
          <div class="inspector-lane-copy">
            <div class="inspector-card-title">File</div>
            <div class="inspector-lane-title-row">
              <span class="inspector-lane-title">{asset.label || baseName(asset.path)}</span>
              <span class="timeline-mode-tag">{asset.kind}</span>
              <span class="inspector-lane-chip">{clipMaskState}</span>
            </div>
            <div class="inspector-lane-meta">{baseName(asset.path)}</div>
          </div>
        </div>

        <div class="inspector-lane-stat-grid">
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata file</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(asset.duration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Durata usata</span>
            <span class="inspector-lane-stat-value">{fmtTimePrecise(usedDuration)}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Risoluzione</span>
            <span class="inspector-lane-stat-value">{resolution}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">FPS</span>
            <span class="inspector-lane-stat-value">{fps}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Sample rate</span>
            <span class="inspector-lane-stat-value">{sampleRate}</span>
          </div>
          <div class="inspector-lane-stat">
            <span class="inspector-lane-stat-label">Preview</span>
            <span class="inspector-lane-stat-value">{previewReady}</span>
          </div>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Uso nella clip</div>
          <InfoRow label="Timeline" value={`${fmtTimePrecise(clip.start)} - ${fmtTimePrecise(clipEnd)}`} />
          <InfoRow label="Source range" value={`${fmtTimePrecise(clip.source_in)} - ${fmtTimePrecise(clip.source_out)}`} />
          <InfoRow label="Origine clip" value={clip.origin} />
          <InfoRow label="Link" value={clip.linked_group_id ? "A/V linked" : "Independent"} />
          <InfoRow label="Captions" value={clip.captions_enabled ? "Enabled" : "Disabled"} />
          <Show when={currentTrack()?.kind === "video" && asset.kind === "video"}>
            <InfoRow label="Mask" value={clipMaskState} />
          </Show>
        </div>

        <div class="inspector-subsection">
          <div class="inspector-card-title">Metadata file</div>
          <InfoRow label="Asset id" value={asset.id} />
          <InfoRow label="Origine file" value={asset.origin} />
          <InfoRow label="Audio embedded" value={asset.has_audio} />
          <Show when={asset.transcript_ref}>
            <InfoRow label="Transcript ref" value={asset.transcript_ref} />
          </Show>
          <InfoRow label="Percorso" value={asset.path} stack code />
        </div>
      </div>
    );
  };

  const renderClipInfoAccordion = () => {
    const clip = currentClip();
    if (!clip) return null;
    return (
      <div class="inspector-accordion-stack">
        <InspectorAccordion icon={<IconMovie />} title="Clip" meta={currentAsset()?.label || "Clip"}>
          <InfoRow label="Timeline" value={`${fmtTimePrecise(clip.start)} - ${fmtTimePrecise(clip.start + (clip.source_out - clip.source_in))}`} />
          <InfoRow label="Source in" value={fmtTimePrecise(clip.source_in)} />
          <InfoRow label="Source out" value={fmtTimePrecise(clip.source_out)} />
          <InfoRow label="Origine" value={clip.origin} />
          <InfoRow label="Link" value={clip.linked_group_id ? "A/V linked" : "Independent"} />
        </InspectorAccordion>
      </div>
    );
  };

  const renderAudioAccordion = () => {
    const clip = currentClip();
    if (!clip || currentTrack()?.kind !== "audio") return null;
    return (
      <div class="inspector-accordion-stack">
        <InspectorAccordion
          icon={<IconWaveSquare />}
          title="Trascrizione"
          meta={`${clip.transcription_status} / ${currentClipTranscriptionWordCount()} parole`}
        >
          <div class="inspector-subsection">
            <div class="inspector-card-title">Transcript</div>
            <InfoRow label="Transcription" value={clip.transcription_status} />
            <Show when={clip.transcription_message}>
              <InfoRow label="Stato" value={clip.transcription_message} />
            </Show>
            <Show when={clip.transcription_status === "running" && currentTranscriptionStep()}>
              {(step) => (
                <>
                  <InfoRow label="Progresso" value={`${step().progress}%`} />
                  <Show when={step().message}>
                    <InfoRow label="Fase" value={step().message} />
                  </Show>
                </>
              )}
            </Show>
            <InfoRow label="Parole" value={currentClipTranscriptionWordCount()} />
            <Show when={clip.transcription_source_audio_path}>
              <InfoRow label="Audio bounce" value={clip.transcription_source_audio_path} />
            </Show>
            <Show when={currentClipTranscriptPreview()}>
              <FormField label="Anteprima transcript" variant="compact">
                <Textarea value={currentClipTranscriptPreview()} readonly rows={4} />
              </FormField>
            </Show>
            <Show when={clip.transcription_status === "completed" && !currentClipTranscriptPreview() && !clip.transcription_message}>
              <InfoRow label="Risultato" value="Nessuna parola disponibile" />
            </Show>
            <Show when={clip.transcription_error}>
              <div class="step-message">{clip.transcription_error}</div>
            </Show>
            <div class="inspector-card-actions">
              <Button
                size="xs"
                disabled={!canTranscribeClip()}
                onClick={runClipTranscription}
              >
                {clipTranscriptionButtonLabel()}
              </Button>
            </div>
          </div>

          <div class="inspector-subsection">
            <div class="inspector-card-title">Setup ASR</div>
            <InfoRow label="Lingua effettiva" value={effectiveClipLanguage()} />
            <InfoRow label="Modello" value={effectiveClipModel()} />
            <FormField label="Lingua clip" variant="compact">
              <Select
                value={effectiveClipLanguage()}
                onChange={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ language: value });
                }}
              >
                <For each={ASR_LANGUAGE_OPTIONS}>
                  {(option) => <option value={option.value}>{option.value}</option>}
                </For>
              </Select>
              <Show when={clip.transcription_options.language !== null}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => updateClipTranscriptionOptions({ language: null })}
                >
                  Reset
                </Button>
              </Show>
            </FormField>
            <FormField label="Modello ASR" variant="compact">
              <Select
                value={effectiveClipModel()}
                onChange={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ model: value });
                }}
              >
                <For each={ASR_MODEL_OPTIONS}>
                  {(option) => <option value={option.value}>{option.label}</option>}
                </For>
              </Select>
              <Show when={clip.transcription_options.model !== null}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => updateClipTranscriptionOptions({ model: null })}
                >
                  Reset
                </Button>
              </Show>
            </FormField>
            <FormField label="Beam size" variant="compact">
              <Input
                type="number"
                min="1"
                max="10"
                placeholder={String(job.data?.request.transcription.beam_size ?? 5)}
                value={clip.transcription_options.beam_size ?? ""}
                onInput={(e) => {
                  const value = e.currentTarget.value.trim();
                  updateClipTranscriptionOptions({ beam_size: value ? Number(value) : null });
                }}
              />
            </FormField>
            <InfoRow label="">
              <Toggle
                label="VAD filter"
                checked={effectiveClipVadFilter()}
                onChange={(e) => updateClipTranscriptionOptions({ vad_filter: (e.currentTarget as HTMLInputElement).checked })}
              />
              <Show when={clip.transcription_options.vad_filter !== null}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => updateClipTranscriptionOptions({ vad_filter: null })}
                >
                  Reset
                </Button>
              </Show>
            </InfoRow>
            <InfoRow label="">
              <Toggle
                label="WhisperX align"
                checked={effectiveClipWhisperX()}
                onChange={(e) => updateClipTranscriptionOptions({ use_whisperx: (e.currentTarget as HTMLInputElement).checked })}
              />
              <Show when={clip.transcription_options.use_whisperx !== null}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => updateClipTranscriptionOptions({ use_whisperx: null })}
                >
                  Reset
                </Button>
              </Show>
            </InfoRow>
          </div>
        </InspectorAccordion>
      </div>
    );
  };

  const renderVideoAccordion = () => {
    const tx = () => currentClip()?.transform.x ?? 0;
    const ty = () => currentClip()?.transform.y ?? 0;
    const tScale = () => currentClip()?.transform.scale ?? 1;
    const tRot = () => currentClip()?.transform.rotation ?? 0;
    const tOpacity = () => currentClip()?.transform.opacity ?? 1;
    const cropLeft = () => currentClip()?.transform.crop.left ?? 0;
    const cropTop = () => currentClip()?.transform.crop.top ?? 0;
    const cropRight = () => currentClip()?.transform.crop.right ?? 0;
    const cropBottom = () => currentClip()?.transform.crop.bottom ?? 0;

    return (
      <Show when={(() => {
        const asset = currentAsset();
        const track = currentTrack();
        return !!currentClip() && asset?.kind === "video" && track?.kind === "video";
      })()}>
        <div class="inspector-accordion-stack">
          <InspectorAccordion
            icon={<IconArrowsMoveHorizontal />}
            title="Trasformazione"
            meta={`x:${Math.round(tx())} y:${Math.round(ty())} s:${tScale().toFixed(2)}`}
            open
          >
            <div class="transform-position-row">
              <div class="transform-xy-fields">
                <div class="transform-field">
                  <span class="transform-field-label">X</span>
                  <DragNumber
                    value={tx()}
                    step={1}
                    unitsPerPixel={1}
                    snapTargets={[0]}
                    onChange={(v) => updateClipTransform({ x: v })}
                  />
                </div>
                <div class="transform-field">
                  <span class="transform-field-label">Y</span>
                  <DragNumber
                    value={ty()}
                    step={1}
                    unitsPerPixel={1}
                    snapTargets={[0]}
                    onChange={(v) => updateClipTransform({ y: v })}
                  />
                </div>
              </div>
              <JoystickPad
                getValue={() => {
                  const c = currentClip();
                  return { x: c?.transform.x ?? 0, y: c?.transform.y ?? 0 };
                }}
                onSet={(x, y) => updateClipTransform({ x, y })}
              />
            </div>

            <div class="transform-grid">
              <div class="transform-field">
                <span class="transform-field-label">Scala</span>
                <DragNumber
                  value={tScale()}
                  min={0.01}
                  step={0.01}
                  unitsPerPixel={0.01}
                  snapTargets={[1]}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => updateClipTransform({ scale: Math.max(0.01, v) })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Rot °</span>
                <DragNumber
                  value={tRot()}
                  min={-360}
                  max={360}
                  step={1}
                  unitsPerPixel={1}
                  snapTargets={[-270, -180, -90, 0, 90, 180, 270]}
                  onChange={(v) => updateClipTransform({ rotation: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Opacità</span>
                <DragNumber
                  value={tOpacity()}
                  min={0}
                  max={1}
                  step={0.01}
                  unitsPerPixel={0.005}
                  snapTargets={[0, 0.5, 1]}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => updateClipTransform({ opacity: v })}
                />
              </div>
            </div>

            <div class="inspector-card-actions">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => updateClipTransform({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 })}
              >
                Reset
              </Button>
            </div>
          </InspectorAccordion>

          <InspectorAccordion
            icon={<IconCrop />}
            title="Crop"
            meta={`L:${Math.round(cropLeft() * 100)}% T:${Math.round(cropTop() * 100)}% R:${Math.round(cropRight() * 100)}% B:${Math.round(cropBottom() * 100)}%`}
          >
            <div class="crop-preview">
              <div
                class="crop-preview-inner"
                style={{
                  left: `${cropLeft() * 100}%`,
                  top: `${cropTop() * 100}%`,
                  right: `${cropRight() * 100}%`,
                  bottom: `${cropBottom() * 100}%`,
                }}
              />
            </div>

            <div class="transform-grid transform-grid--2">
              <div class="transform-field">
                <span class="transform-field-label">← Sinistra</span>
                <DragNumber
                  value={cropLeft()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  snapTargets={[0]}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ left: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Destra →</span>
                <DragNumber
                  value={cropRight()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  snapTargets={[0]}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ right: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">↑ Alto</span>
                <DragNumber
                  value={cropTop()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  snapTargets={[0]}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ top: v })}
                />
              </div>
              <div class="transform-field">
                <span class="transform-field-label">Basso ↓</span>
                <DragNumber
                  value={cropBottom()}
                  min={0} max={1} step={0.01} unitsPerPixel={0.005}
                  snapTargets={[0]}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateClipCrop({ bottom: v })}
                />
              </div>
            </div>
            <div class="inspector-card-actions">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => updateClipCrop({ left: 0, top: 0, right: 0, bottom: 0 })}
              >
                Reset crop
              </Button>
            </div>
          </InspectorAccordion>

          <InspectorAccordion
            icon={<IconScissors />}
            title="Mask"
            meta={backgroundRemoval()?.status ?? "idle"}
          >
            <div class="inspector-card-actions inspector-card-actions--spread">
              <Button
                size="xs"
                disabled={startBackgroundRemoval.isPending || backgroundRemoval()?.status === "running"}
                onClick={runBackgroundRemoval}
              >
                {backgroundRemoval()?.mask_video_path ? "Rigenera mask" : "Genera mask"}
              </Button>
              <Toggle
                label="Usa mask su questo clip"
                checked={currentClip()?.mask_enabled ?? false}
                onChange={(event) => setClipMaskEnabled((event.currentTarget as HTMLInputElement).checked)}
              />
            </div>
            <InfoRow label="Mask asset" value={backgroundRemoval()?.status ?? "idle"} />
            <Show when={backgroundRemoval()}>
              {(mask) => (
                <>
                  <Show when={mask().message}>
                    <InfoRow label="Stato" value={mask().message} />
                  </Show>
                  <InfoRow label="Mask clip" value={currentClip()?.mask_enabled ? "enabled" : "disabled"} />
                  <Show when={mask().mask_video_path}>
                    <InfoRow label="Video mask" value={mask().mask_video_path} />
                  </Show>
                  <Show when={mask().status === "running"}>
                    <InfoRow label="Progresso" value={`${Math.round((mask().progress ?? 0) * 100)}%`} />
                  </Show>
                  <Show when={mask().error}>
                    <div class="step-message">{mask().error}</div>
                  </Show>
                </>
              )}
            </Show>
          </InspectorAccordion>
        </div>
      </Show>
    );
  };

  return (
    <div class="panel inspector-panel">
      <Show when={props.project()} fallback={<div class="placeholder inspector-panel-empty">Seleziona un progetto</div>}>
        <>
          <div class="inspector-panel-body">
            <Switch>
              <Match when={activeTab() === "video"}>
                <div class="inspector-panel-section">
                  <Show when={hasVideoSettings()} fallback={<div class="placeholder inspector-panel-empty">Nessuna impostazione video disponibile.</div>}>
                    <>
                      {renderVideoAccordion()}
                      {renderClipInfoAccordion()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "lane"}>
                <div class="inspector-panel-section">
                  <Show when={hasLaneSettings()} fallback={<div class="placeholder inspector-panel-empty">Seleziona una lane o un blocco testo dalla timeline.</div>}>
                    <>
                      {renderLanePanel()}
                      {renderSubtitlePanel()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "audio"}>
                <div class="inspector-panel-section">
                  <Show when={hasAudioSettings()} fallback={<div class="placeholder inspector-panel-empty">Nessuna impostazione audio disponibile.</div>}>
                    <>
                      {renderAudioAccordion()}
                      {renderClipInfoAccordion()}
                    </>
                  </Show>
                </div>
              </Match>
              <Match when={activeTab() === "file"}>
                <div class="inspector-panel-section">
                  <Show when={hasFileSettings()} fallback={<div class="placeholder inspector-panel-empty">Seleziona una clip per vedere il file sorgente.</div>}>
                    {renderFilePanel()}
                  </Show>
                </div>
              </Match>
            </Switch>
          </div>

          <div class="inspector-tabbar" role="tablist" aria-label="Categorie inspector">
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "video" ? " active" : ""}`}
              aria-selected={activeTab() === "video"}
              disabled={!hasVideoSettings()}
              onClick={() => selectTab("video")}
            >
              <IconVideo />
              Video
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "lane" ? " active" : ""}`}
              aria-selected={activeTab() === "lane"}
              disabled={!hasLaneSettings()}
              onClick={() => selectTab("lane")}
            >
              <IconStack2 />
              Lane
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "audio" ? " active" : ""}`}
              aria-selected={activeTab() === "audio"}
              disabled={!hasAudioSettings()}
              onClick={() => selectTab("audio")}
            >
              <IconWaveSquare />
              Audio
            </button>
            <button
              type="button"
              role="tab"
              class={`inspector-tab${activeTab() === "file" ? " active" : ""}`}
              aria-selected={activeTab() === "file"}
              disabled={!hasFileSettings()}
              onClick={() => selectTab("file")}
            >
              <IconMovie />
              File
            </button>
          </div>
        </>
      </Show>
    </div>
  );
};

export default ParamsInspector;
