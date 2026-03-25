import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show, Switch, Match, type Component } from "solid-js";
import { useJobQuery, useUpdateRequestMutation, useRunStepMutation, useArtifactQuery, useUpdateTranscriptMutation } from "../api/queries";
import { selectedJobId, selectedStep, editingWord, playheadTime, setEditingWord, setSeekRequest } from "../store";
import { buildArtifactCatalog, canRunStep, capitalize, fmtTimePrecise } from "../lib/utils";
import type { JobSnapshot } from "../types";

const ParamsInspector: Component = () => {
  const job = useJobQuery(selectedJobId);
  const updateReq = useUpdateRequestMutation();
  const runStepMut = useRunStepMutation();
  const [dirty, setDirty] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const data = () => job.data as JobSnapshot | undefined;
  const canEdit = () => data()?.status !== "running";
  const step = () => selectedStep();

  const stepSnapshot = createMemo(() => {
    const j = data();
    const s = step();
    if (!j || !s) return null;
    return j.steps.find((st) => st.name === s) ?? null;
  });

  const stepCanRun = createMemo(() => {
    const j = data();
    const s = step();
    return j && s ? canRunStep(j, s) : false;
  });

  const val = (name: string, fb: string): string => {
    const el = containerRef?.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    return el?.value?.trim() || fb;
  };
  const num = (name: string, fb: number): number => {
    const el = containerRef?.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    const v = Number(el?.value);
    return Number.isFinite(v) ? v : fb;
  };
  const chk = (name: string): boolean => {
    const el = containerRef?.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    return el?.checked ?? false;
  };

  const save = async () => {
    const j = data();
    const s = step();
    if (!j || !s) return;
    const req = j.request;

    const payload = (() => {
      switch (s) {
        case "ingest":
          return {
            title: val("p_title", req.title),
            profile: val("p_profile", req.profile),
            language: val("p_language", req.language),
            editorial_notes: val("p_editorial_notes", req.editorial_notes),
            toggles: {
              use_whisperx: chk("p_use_whisperx"),
              use_local_llm: chk("p_use_local_llm"),
              render_clean: chk("p_render_clean"),
              render_captioned: chk("p_render_captioned"),
            },
          };
        case "transcription":
          return {
            transcription: {
              model: val("p_tr_model", req.transcription.model),
              beam_size: num("p_tr_beam_size", req.transcription.beam_size),
              vad_filter: chk("p_tr_vad_filter"),
              condition_on_prev_text: chk("p_tr_condition"),
              word_timestamps: chk("p_tr_word_ts"),
              compute_type: val("p_tr_compute", req.transcription.compute_type),
              device: val("p_tr_device", req.transcription.device),
            },
          };
        case "editorial":
          return {
            decision: {
              filler_words: val("p_dec_fillers", "").split(",").map((item) => item.trim()).filter(Boolean),
              repetition_window_seconds: num("p_dec_repwin", req.decision.repetition_window_seconds),
              soft_pause_threshold_seconds: num("p_dec_soft", req.decision.soft_pause_threshold_seconds),
              hard_pause_threshold_seconds: num("p_dec_hard", req.decision.hard_pause_threshold_seconds),
              leading_context_seconds: num("p_dec_lead", req.decision.leading_context_seconds),
              trailing_context_seconds: num("p_dec_trail", req.decision.trailing_context_seconds),
              retained_pause_seconds: num("p_dec_retained", req.decision.retained_pause_seconds),
            },
          };
        case "render":
          return {
            subtitle: {
              chunk_words: num("p_sub_chunk", req.subtitle.chunk_words),
              font_name: val("p_sub_font", req.subtitle.font_name),
              font_size: num("p_sub_fontsize", req.subtitle.font_size),
              text_color: val("p_sub_textcolor", req.subtitle.text_color),
              active_color: val("p_sub_activecolor", req.subtitle.active_color),
              outline_color: val("p_sub_outlinecolor", req.subtitle.outline_color),
              bottom_margin: num("p_sub_margin", req.subtitle.bottom_margin),
              pop_in_ms: num("p_sub_popin", req.subtitle.pop_in_ms),
            },
            render: {
              width: (() => { const r = val("p_rn_resolution", ""); const p = r.split("x"); return p.length === 2 ? Number(p[0]) : req.render.width; })(),
              height: (() => { const r = val("p_rn_resolution", ""); const p = r.split("x"); return p.length === 2 ? Number(p[1]) : req.render.height; })(),
              video_codec: val("p_rn_vcodec", req.render.video_codec),
              audio_codec: val("p_rn_acodec", req.render.audio_codec),
              crf: num("p_rn_crf", req.render.crf),
              preset: val("p_rn_preset", req.render.preset),
              audio_bitrate: val("p_rn_abitrate", req.render.audio_bitrate),
            },
          };
        default:
          return {};
      }
    })();

    if (Object.keys(payload).length === 0) {
      setDirty(false);
      subEditorSavedCb?.();
      return;
    }

    await updateReq.mutateAsync({ jobId: j.id, payload });
    setDirty(false);
    subEditorSavedCb?.();
  };

  // Callback to reset SubtitleLiveEditor dirty state after save
  let subEditorSavedCb: (() => void) | undefined;

  const handleRunStep = async () => {
    const j = data();
    const s = step();
    if (!j || !s) return;
    // Auto-save dirty params before running
    if (dirty()) await save();
    runStepMut.mutate({ jobId: j.id, stepName: s });
  };

  const Field = (props: { label: string; name: string; value: string | number; type?: string; extra?: string }) => (
    <label class="param-field">
      <span>{props.label}</span>
      <input
        type={props.type || "text"}
        name={props.name}
        value={String(props.value)}
        disabled={!canEdit()}
        onInput={() => setDirty(true)}
        step={props.extra}
      />
    </label>
  );

  const Select = (props: { label: string; name: string; value: string; options: string[] }) => (
    <label class="param-field">
      <span>{props.label}</span>
      <select
        name={props.name}
        disabled={!canEdit()}
        onChange={() => setDirty(true)}
      >
        {props.options.map((o) => (
          <option value={o} selected={o === props.value}>{o}</option>
        ))}
      </select>
    </label>
  );

  const Check = (props: { label: string; name: string; checked: boolean }) => (
    <label class="toggle">
      <input
        type="checkbox"
        name={props.name}
        checked={props.checked}
        disabled={!canEdit()}
        onChange={() => setDirty(true)}
      />
      <span>{props.label}</span>
    </label>
  );

  return (
    <div class="panel inspector-panel">
      <Show when={data() && step()} fallback={<div class="placeholder">Seleziona un progetto e uno step</div>}>
        {(_) => {
          const req = () => data()!.request;
          const ss = () => stepSnapshot();
          return (
            <div ref={containerRef}>
              {/* Step header with status + actions */}
              <div class="step-inspector-header">
                <div class="step-inspector-title">
                  <span class={`status-dot ${ss()?.status ?? "pending"}`} />
                  <strong>{capitalize(step()!)}</strong>
                  <Show when={ss()?.status === "completed"}>
                    <span class="step-completed-label">completato</span>
                  </Show>
                  <Show when={ss()?.status === "running"}>
                    <span class="step-running-label">in esecuzione...</span>
                  </Show>
                  <Show when={ss()?.status === "failed"}>
                    <span class="step-failed-label">fallito</span>
                  </Show>
                </div>
                <div class="step-inspector-actions">
                  <Show when={dirty()}>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs"
                      disabled={!canEdit()}
                      onClick={save}
                    >
                      {updateReq.isPending ? "Salvataggio..." : "Salva"}
                    </button>
                  </Show>
                  <Show when={ss()}>
                    <button
                      type="button"
                      class="btn btn-primary btn-xs"
                      disabled={!stepCanRun() || runStepMut.isPending}
                      onClick={handleRunStep}
                      title={ss()?.blocked_reason || ""}
                    >
                      {ss()?.status === "completed" ? "Riesegui" : "Esegui"}
                    </button>
                  </Show>
                </div>
              </div>

              <Show when={ss()?.message}>
                <div class="step-message">{ss()!.message}</div>
              </Show>
              <Show when={!stepCanRun() && ss()?.blocked_reason && data()?.status !== "running"}>
                <div class="step-message">{ss()!.blocked_reason}</div>
              </Show>

              {/* Step-specific content */}
              <div class="step-params">
                <Switch>
                  <Match when={step() === "ingest"}>
                    <Field label="Titolo" name="p_title" value={req().title} />
                    <Select label="Lingua" name="p_language" value={req().language} options={["it", "en", "es", "fr", "de", "pt", "ja", "zh", "ko", "auto"]} />
                    <Select label="Profilo" name="p_profile" value={req().profile} options={["fast", "balanced", "quality", "custom"]} />
                    <label class="param-field full">
                      <span>Note editoriali</span>
                      <textarea
                        name="p_editorial_notes"
                        rows="2"
                        disabled={!canEdit()}
                        onInput={() => setDirty(true)}
                      >
                        {req().editorial_notes}
                      </textarea>
                    </label>
                    <div class="param-toggle-row">
                      <Check label="WhisperX" name="p_use_whisperx" checked={req().toggles.use_whisperx} />
                      <Check label="LLM locale" name="p_use_local_llm" checked={req().toggles.use_local_llm} />
                      <Check label="Export clean" name="p_render_clean" checked={req().toggles.render_clean} />
                      <Check label="Export captioned" name="p_render_captioned" checked={req().toggles.render_captioned} />
                    </div>
                  </Match>

                  <Match when={step() === "transcription"}>
                    <Select label="Model" name="p_tr_model" value={req().transcription.model} options={["tiny", "base", "small", "medium", "large-v2", "large-v3", "distil-large-v3"]} />
                    <Field label="Beam size" name="p_tr_beam_size" value={req().transcription.beam_size} type="number" />
                    <Select label="Compute type" name="p_tr_compute" value={req().transcription.compute_type} options={["int8", "float16", "float32"]} />
                    <Select label="Device" name="p_tr_device" value={req().transcription.device} options={["auto", "cpu", "cuda", "mps"]} />
                    <div class="param-toggle-row">
                      <Check label="VAD filter" name="p_tr_vad_filter" checked={req().transcription.vad_filter} />
                      <Check label="Prev text" name="p_tr_condition" checked={req().transcription.condition_on_prev_text} />
                      <Check label="Word timestamps" name="p_tr_word_ts" checked={req().transcription.word_timestamps} />
                    </div>
                    <div class="step-empty-info">
                      Dopo l'esecuzione puoi modificare le parole qui e regolare start/end nella timeline in basso.
                    </div>
                    <div class="full"><TranscriptEditor jobId={() => data()!.id} mode="transcription" /></div>
                  </Match>

                  <Match when={step() === "editorial"}>
                    <Field label="Soft pause (s)" name="p_dec_soft" value={req().decision.soft_pause_threshold_seconds} type="number" extra="0.01" />
                    <Field label="Hard pause (s)" name="p_dec_hard" value={req().decision.hard_pause_threshold_seconds} type="number" extra="0.01" />
                    <Field label="Lead ctx (s)" name="p_dec_lead" value={req().decision.leading_context_seconds} type="number" extra="0.01" />
                    <Field label="Trail ctx (s)" name="p_dec_trail" value={req().decision.trailing_context_seconds} type="number" extra="0.01" />
                    <Field label="Retained (s)" name="p_dec_retained" value={req().decision.retained_pause_seconds} type="number" extra="0.01" />
                    <Field label="Rep win (s)" name="p_dec_repwin" value={req().decision.repetition_window_seconds} type="number" extra="0.01" />
                    <label class="param-field full">
                      <span>Filler words</span>
                      <textarea
                        name="p_dec_fillers"
                        rows="2"
                        disabled={!canEdit()}
                        onInput={() => setDirty(true)}
                      >
                        {(req().decision.filler_words || []).join(", ")}
                      </textarea>
                    </label>
                  </Match>

                  <Match when={step() === "render"}>
                    <Show when={!req().toggles.render_clean || !req().toggles.render_captioned}>
                      <div class="step-message">
                        Output attivi:
                        {` edited master${req().toggles.render_clean ? ", clean" : ""}${req().toggles.render_captioned ? ", captioned" : ""}. `}
                        Modifica gli export nello step Ingest.
                      </div>
                    </Show>
                    <SubtitleLiveEditor req={req} onDirty={() => setDirty(true)} onSavedRef={(cb) => { subEditorSavedCb = cb; }} />
                    <Select label="Risoluzione" name="p_rn_resolution" value={`${req().render.width}x${req().render.height}`} options={["1080x1920", "720x1280", "1080x1080", "1920x1080"]} />
                    <Select label="Video codec" name="p_rn_vcodec" value={req().render.video_codec} options={["libx264", "libx265", "libopenh264", "mpeg4"]} />
                    <Select label="Audio codec" name="p_rn_acodec" value={req().render.audio_codec} options={["aac", "libmp3lame", "opus", "pcm_s16le"]} />
                    <Select label="Preset" name="p_rn_preset" value={req().render.preset} options={["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]} />
                    <Field label="CRF" name="p_rn_crf" value={req().render.crf} type="number" />
                    <Select label="Audio bitrate" name="p_rn_abitrate" value={req().render.audio_bitrate} options={["96k", "128k", "192k", "256k", "320k"]} />
                  </Match>
                </Switch>
              </div>

              {/* Artifacts produced by this step */}
              <Show when={(ss()?.artifacts?.length ?? 0) > 0}>
                <div class="step-artifacts">
                  <div class="step-artifacts-title">Artifacts</div>
                  <div class="step-artifacts-list">
                    {ss()!.artifacts.map((a) => (
                      <span class="step-artifact-tag">{a.split("/").pop()}</span>
                    ))}
                  </div>
                </div>
              </Show>
            </div>
          );
        }}
      </Show>
    </div>
  );
};

/* ---- Transcript Editor ---- */

interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}
interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}
interface TranscriptData {
  language: string;
  segments: TranscriptSegment[];
  source: string;
  notes: string[];
}

const MIN_WORD_DURATION = 0.02;

const TranscriptEditor: Component<{ jobId: () => string; mode: "transcription" | "alignment" }> = (props) => {
  const alignedPath = createMemo(() => `artifacts/04_transcript_aligned.json`);
  const rawPath = createMemo(() => `artifacts/03_transcript_raw.json`);

  const alignedQ = useArtifactQuery(props.jobId, alignedPath);
  const rawQ = useArtifactQuery(props.jobId, rawPath);

  const updateMut = useUpdateTranscriptMutation();

  const title = () => (props.mode === "alignment" ? "Allineamento" : "Trascrizione");

  const transcript = createMemo((): TranscriptData | null => {
    const a = alignedQ.data?.data as TranscriptData | undefined;
    const r = rawQ.data?.data as TranscriptData | undefined;
    if (props.mode === "transcription") return a?.segments?.length ? a : (r?.segments?.length ? r : null);
    if (a?.segments?.length) return a;
    if (r?.segments?.length) return r;
    return null;
  });

  // Local editable copy
  const [localTranscript, setLocalTranscript] = createSignal<TranscriptData | null>(null);
  const [transcriptDirty, setTranscriptDirty] = createSignal(false);

  // Sync from server when data arrives
  createEffect(
    on(transcript, (t) => {
      if (t && !transcriptDirty()) {
        setLocalTranscript(JSON.parse(JSON.stringify(t)));
      }
    }),
  );

  const ew = editingWord;
  const timelineRefs: Array<HTMLDivElement | undefined> = [];
  let dragCleanup: (() => void) | undefined;

  const startEdit = (segIdx: number, wordIdx: number) => {
    setEditingWord({ seg: segIdx, word: wordIdx });
  };

  const stopDragging = () => {
    dragCleanup?.();
    dragCleanup = undefined;
  };

  onCleanup(stopDragging);
  createEffect(() => {
    if (props.mode !== "alignment") stopDragging();
  });

  const syncSegment = (copy: TranscriptData, segIdx: number) => {
    const segment = copy.segments[segIdx];
    segment.text = segment.words.map((w) => w.text).join(" ");
    if (segment.words.length > 0) {
      segment.start = segment.words[0].start;
      segment.end = segment.words[segment.words.length - 1].end;
    }
  };

  const updateWord = (segIdx: number, wordIdx: number, newText: string) => {
    setLocalTranscript((prev) => {
      if (!prev) return prev;
      const copy: TranscriptData = JSON.parse(JSON.stringify(prev));
      copy.segments[segIdx].words[wordIdx].text = newText;
      syncSegment(copy, segIdx);
      return copy;
    });
    setTranscriptDirty(true);
  };

  const updateWordTiming = (
    segIdx: number,
    wordIdx: number,
    field: "start" | "end",
    rawValue: string | number,
  ) => {
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) return;
    setLocalTranscript((prev) => {
      if (!prev) return prev;
      const copy: TranscriptData = JSON.parse(JSON.stringify(prev));
      const words = copy.segments[segIdx].words;
      const word = copy.segments[segIdx].words[wordIdx];
      if (field === "start") {
        const prevEnd = wordIdx > 0 ? words[wordIdx - 1].end : 0;
        const maxStart = Math.max(prevEnd, word.end - MIN_WORD_DURATION);
        word.start = Math.min(maxStart, Math.max(prevEnd, value));
      } else {
        const nextStart = wordIdx < words.length - 1 ? words[wordIdx + 1].start : Number.POSITIVE_INFINITY;
        const minEnd = word.start + MIN_WORD_DURATION;
        const maxEnd = Number.isFinite(nextStart) ? Math.max(minEnd, nextStart) : Number.POSITIVE_INFINITY;
        word.end = Math.max(minEnd, Math.min(maxEnd, value));
      }
      syncSegment(copy, segIdx);
      return copy;
    });
    setTranscriptDirty(true);
  };

  const deleteWord = (segIdx: number, wordIdx: number) => {
    setLocalTranscript((prev) => {
      if (!prev) return prev;
      const copy: TranscriptData = JSON.parse(JSON.stringify(prev));
      copy.segments[segIdx].words.splice(wordIdx, 1);
      syncSegment(copy, segIdx);
      return copy;
    });
    setEditingWord(null);
    setTranscriptDirty(true);
  };

  const saveTranscript = async () => {
    const t = localTranscript();
    if (!t) return;
    await updateMut.mutateAsync({
      jobId: props.jobId(),
      transcript: t,
      target: props.mode,
    });
    setTranscriptDirty(false);
    setEditingWord(null);
  };

  const seekToWord = (word: TranscriptWord) => {
    setSeekRequest(word.start);
  };

  const confColor = (c: number) => {
    if (c >= 0.9) return "var(--green)";
    if (c >= 0.7) return "var(--text)";
    if (c >= 0.5) return "var(--yellow)";
    return "var(--red)";
  };

  const segmentDomain = (segment: TranscriptSegment) => {
    const duration = Math.max(0.2, segment.end - segment.start);
    const padding = Math.max(0.18, duration * 0.2);
    const start = Math.max(0, segment.start - padding);
    const end = segment.end + padding;
    return { start, end: end > start ? end : start + 0.5 };
  };

  const toSegmentPct = (segment: TranscriptSegment, sec: number) => {
    const domain = segmentDomain(segment);
    return ((sec - domain.start) / (domain.end - domain.start)) * 100;
  };

  const wordLeftPct = (segment: TranscriptSegment, word: TranscriptWord) =>
    Math.max(0, Math.min(100, toSegmentPct(segment, word.start)));

  const wordWidthPct = (segment: TranscriptSegment, word: TranscriptWord) =>
    Math.max(2, Math.min(100, toSegmentPct(segment, word.end) - toSegmentPct(segment, word.start)));

  const playheadPct = (segment: TranscriptSegment) => {
    const domain = segmentDomain(segment);
    const current = playheadTime();
    if (current < domain.start || current > domain.end) return null;
    return ((current - domain.start) / (domain.end - domain.start)) * 100;
  };

  const seekWithinSegment = (segIdx: number, clientX: number) => {
    const timeline = timelineRefs[segIdx];
    const segment = localTranscript()?.segments[segIdx];
    if (!timeline || !segment) return;
    const rect = timeline.getBoundingClientRect();
    const domain = segmentDomain(segment);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const time = domain.start + ratio * (domain.end - domain.start);
    setSeekRequest(time);
  };

  const beginHandleDrag = (
    event: PointerEvent,
    segIdx: number,
    wordIdx: number,
    edge: "start" | "end",
  ) => {
    const timeline = timelineRefs[segIdx];
    if (!timeline) return;
    event.preventDefault();
    event.stopPropagation();
    startEdit(segIdx, wordIdx);

    const applyFromClientX = (clientX: number) => {
      const segment = localTranscript()?.segments[segIdx];
      if (!segment) return;
      const rect = timeline.getBoundingClientRect();
      const domain = segmentDomain(segment);
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const time = domain.start + ratio * (domain.end - domain.start);
      updateWordTiming(segIdx, wordIdx, edge, time);
      setSeekRequest(time);
    };

    stopDragging();
    applyFromClientX(event.clientX);

    const onMove = (moveEvent: PointerEvent) => applyFromClientX(moveEvent.clientX);
    const onUp = () => stopDragging();

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    dragCleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  };

  return (
    <div class="transcript-editor">
      <div class="transcript-editor-header">
        <span class="transcript-editor-title">{title()}</span>
        <Show when={transcriptDirty()}>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            disabled={updateMut.isPending}
            onClick={saveTranscript}
          >
            {updateMut.isPending ? "Salvataggio..." : `Salva ${title().toLowerCase()}`}
          </button>
        </Show>
      </div>
      <Show
        when={localTranscript()}
        fallback={
          <div class="step-empty-info">
            {props.mode === "alignment"
              ? "Nessun allineamento disponibile. Esegui transcription o alignment."
              : "Nessun transcript disponibile. Esegui lo step di trascrizione."}
          </div>
        }
      >
        {(t) => (
          <div class="transcript-segments">
            <Index each={t().segments}>
              {(seg, si) => (
                <div class="transcript-segment">
                  <div class="transcript-segment-time">{fmtTimePrecise(seg().start)}</div>
                  <Show
                    when={props.mode === "alignment"}
                    fallback={
                      <div class="transcript-words">
                        <Index each={seg().words}>
                          {(word, wi) => {
                            const isEditing = () => {
                              const e = ew();
                              return e !== null && e.seg === si && e.word === wi;
                            };

                            return (
                              <Show
                                when={isEditing()}
                                fallback={
                                  <span
                                    class="transcript-word"
                                    style={{ color: confColor(word().confidence) }}
                                    title={`${word().text} [${fmtTimePrecise(word().start)}-${fmtTimePrecise(word().end)}] conf: ${Math.round(word().confidence * 100)}%`}
                                    onClick={() => startEdit(si, wi)}
                                    onDblClick={() => seekToWord(word())}
                                  >
                                    {word().text}
                                  </span>
                                }
                              >
                                <span
                                  class="transcript-word-edit"
                                  onFocusOut={(e) => {
                                    const next = e.relatedTarget;
                                    if (!next || !(e.currentTarget as HTMLElement).contains(next as Node)) {
                                      setEditingWord(null);
                                    }
                                  }}
                                >
                                  <input
                                    type="text"
                                    class="transcript-word-input"
                                    value={word().text}
                                    autofocus
                                    onInput={(e) => updateWord(si, wi, e.currentTarget.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") setEditingWord(null);
                                      if (e.key === "Escape") setEditingWord(null);
                                      if (e.key === "Delete" && e.shiftKey) deleteWord(si, wi);
                                      if (e.key === "Tab") {
                                        e.preventDefault();
                                        const nextWord = e.shiftKey ? wi - 1 : wi + 1;
                                        if (nextWord >= 0 && nextWord < seg().words.length) {
                                          setEditingWord({ seg: si, word: nextWord });
                                        } else {
                                          setEditingWord(null);
                                        }
                                      }
                                    }}
                                  />
                                </span>
                              </Show>
                            );
                          }}
                        </Index>
                      </div>
                    }
                  >
                    <div class="alignment-editor">
                      <div class="alignment-hint">Trascina i bordi laterali della parola selezionata per regolare start e end.</div>
                      <div
                        ref={(el) => {
                          timelineRefs[si] = el;
                        }}
                        class="alignment-track"
                        onPointerDown={(e) => {
                          if (e.target === e.currentTarget) seekWithinSegment(si, e.clientX);
                        }}
                      >
                        <Show when={playheadPct(seg()) !== null}>
                          {(pct) => <div class="alignment-playhead" style={{ left: `${pct()}%` }} />}
                        </Show>
                        <Index each={seg().words}>
                          {(word, wi) => {
                            const isSelected = () => {
                              const e = ew();
                              return e !== null && e.seg === si && e.word === wi;
                            };

                            return (
                              <button
                                type="button"
                                class={`alignment-word-bar${isSelected() ? " is-selected" : ""}`}
                                style={{
                                  left: `${wordLeftPct(seg(), word())}%`,
                                  width: `${wordWidthPct(seg(), word())}%`,
                                  color: confColor(word().confidence),
                                }}
                                title={`${word().text} [${fmtTimePrecise(word().start)}-${fmtTimePrecise(word().end)}]`}
                                onClick={() => startEdit(si, wi)}
                                onDblClick={() => seekToWord(word())}
                              >
                                <span class="alignment-word-label">{word().text}</span>
                                <Show when={isSelected()}>
                                  <>
                                    <span
                                      class="alignment-handle alignment-handle--start"
                                      onPointerDown={(e) => beginHandleDrag(e, si, wi, "start")}
                                    />
                                    <span
                                      class="alignment-handle alignment-handle--end"
                                      onPointerDown={(e) => beginHandleDrag(e, si, wi, "end")}
                                    />
                                  </>
                                </Show>
                              </button>
                            );
                          }}
                        </Index>
                      </div>
                      <Show when={ew()?.seg === si && seg().words[ew()!.word]}>
                        <div class="alignment-selection">
                          <span class="alignment-selection-word">{seg().words[ew()!.word].text}</span>
                          <span>{fmtTimePrecise(seg().words[ew()!.word].start)}</span>
                          <span>{fmtTimePrecise(seg().words[ew()!.word].end)}</span>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </Index>
          </div>
        )}
      </Show>
    </div>
  );
};

/* ---- Subtitle Live Editor (embedded in Render step) ---- */

const SAMPLE_WORDS = ["Questo", "e'", "un", "esempio"];

const SubtitleLiveEditor: Component<{
  req: () => JobSnapshot["request"];
  onDirty: () => void;
  onSavedRef?: (cb: () => void) => void;
}> = (props) => {
  const job = useJobQuery(selectedJobId);
  const jData = () => job.data as JobSnapshot | undefined;

  const [fontName, setFontName] = createSignal("");
  const [fontSize, setFontSize] = createSignal(68);
  const [textColor, setTextColor] = createSignal("FFFFFF");
  const [activeColor, setActiveColor] = createSignal("73E3FF");
  const [outlineColor, setOutlineColor] = createSignal("101214");
  const [bottomMargin, setBottomMargin] = createSignal(220);
  const [popInMs, setPopInMs] = createSignal(140);
  const [chunkWords, setChunkWords] = createSignal(3);
  const [activeIdx, setActiveIdx] = createSignal(0);
  const [subDirty, setSubDirty] = createSignal(false);

  // Only sync from server when the user hasn't made local edits
  createEffect(
    on(
      () => props.req().subtitle,
      (sub) => {
        if (!sub || subDirty()) return;
        setFontName(sub.font_name);
        setFontSize(sub.font_size);
        setTextColor(sub.text_color);
        setActiveColor(sub.active_color);
        setOutlineColor(sub.outline_color);
        setBottomMargin(sub.bottom_margin);
        setPopInMs(sub.pop_in_ms);
        setChunkWords(sub.chunk_words);
      },
    ),
  );

  const captionsPath = createMemo(() => {
    const j = jData();
    if (!j) return null;
    return buildArtifactCatalog(j).find((i) => i.path.endsWith("07_caption_display.json"))?.path ?? null;
  });
  const captionsQ = useArtifactQuery(() => jData()?.id ?? null, captionsPath);

  const previewWords = createMemo(() => {
    const cap = captionsQ.data?.data as { chunks?: { display_words?: string[] }[] } | undefined;
    if (cap?.chunks?.length) {
      const first = cap.chunks[0];
      if (first.display_words?.length) return first.display_words;
    }
    return SAMPLE_WORDS;
  });

  let animTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const words = previewWords();
    if (animTimer) clearInterval(animTimer);
    setActiveIdx(0);
    animTimer = setInterval(() => {
      setActiveIdx((i) => (i + 1) % words.length);
    }, 800);
  });
  onCleanup(() => { if (animTimer) clearInterval(animTimer); });

  // Register reset callback so parent save() can clear our dirty state
  props.onSavedRef?.(() => setSubDirty(false));

  const markDirty = () => { setSubDirty(true); props.onDirty(); };
  const hexToCss = (hex: string) => `#${hex}`;
  const setAndDirty = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); markDirty(); };

  return (
    <div class="sub-live-editor">
      <input type="hidden" name="p_sub_font" value={fontName()} />
      <input type="hidden" name="p_sub_fontsize" value={String(fontSize())} />
      <input type="hidden" name="p_sub_textcolor" value={textColor()} />
      <input type="hidden" name="p_sub_activecolor" value={activeColor()} />
      <input type="hidden" name="p_sub_outlinecolor" value={outlineColor()} />
      <input type="hidden" name="p_sub_margin" value={String(bottomMargin())} />
      <input type="hidden" name="p_sub_popin" value={String(popInMs())} />
      <input type="hidden" name="p_sub_chunk" value={String(chunkWords())} />

      <div
        class="sub-preview-stage"
        style={{
          background: "linear-gradient(180deg, #111 0%, #1a1a2e 50%, #0a0a15 100%)",
          "aspect-ratio": "9 / 16",
          "max-height": "300px",
        }}
      >
        <div
          class="sub-preview-text"
          style={{
            "font-family": `"${fontName()}", sans-serif`,
            "font-size": `${Math.round(fontSize() * 0.38)}px`,
            "padding-bottom": `${Math.round(bottomMargin() * 0.12)}px`,
          }}
        >
          {previewWords().map((word, i) => (
            <span
              style={{
                color: hexToCss(i === activeIdx() ? activeColor() : textColor()),
                transform: i === activeIdx() ? "scale(1.06)" : "scale(1)",
                display: "inline-block",
                transition: `color ${popInMs()}ms ease, transform ${popInMs()}ms ease`,
                "-webkit-text-stroke": `2px ${hexToCss(outlineColor())}`,
                "paint-order": "stroke fill",
                "margin-right": "6px",
                "font-weight": "700",
              }}
            >
              {word}
            </span>
          ))}
        </div>
      </div>

      <div class="sub-controls">
        <div class="sub-control-row">
          <label class="sub-label">Font</label>
          <input type="text" class="sub-input" value={fontName()} onInput={(e) => setAndDirty(setFontName)(e.currentTarget.value)} />
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Size</label>
          <input type="range" min="24" max="140" value={fontSize()} onInput={(e) => setAndDirty(setFontSize)(Number(e.currentTarget.value))} />
          <span class="sub-value">{fontSize()}</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Text</label>
          <input type="color" value={hexToCss(textColor())} onInput={(e) => setAndDirty(setTextColor)(e.currentTarget.value.replace("#", "").toUpperCase())} />
          <span class="sub-value">#{textColor()}</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Active</label>
          <input type="color" value={hexToCss(activeColor())} onInput={(e) => setAndDirty(setActiveColor)(e.currentTarget.value.replace("#", "").toUpperCase())} />
          <span class="sub-value">#{activeColor()}</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Outline</label>
          <input type="color" value={hexToCss(outlineColor())} onInput={(e) => setAndDirty(setOutlineColor)(e.currentTarget.value.replace("#", "").toUpperCase())} />
          <span class="sub-value">#{outlineColor()}</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Margin</label>
          <input type="range" min="80" max="480" value={bottomMargin()} onInput={(e) => setAndDirty(setBottomMargin)(Number(e.currentTarget.value))} />
          <span class="sub-value">{bottomMargin()}</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Pop-in</label>
          <input type="range" min="0" max="1000" step="10" value={popInMs()} onInput={(e) => setAndDirty(setPopInMs)(Number(e.currentTarget.value))} />
          <span class="sub-value">{popInMs()}ms</span>
        </div>
        <div class="sub-control-row">
          <label class="sub-label">Words/chunk</label>
          <input type="range" min="1" max="6" value={chunkWords()} onInput={(e) => setAndDirty(setChunkWords)(Number(e.currentTarget.value))} />
          <span class="sub-value">{chunkWords()}</span>
        </div>
      </div>
    </div>
  );
};

export default ParamsInspector;
