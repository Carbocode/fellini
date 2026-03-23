const bootstrap = window.__FELLINI_BOOTSTRAP__ || {
  profiles: [],
  executionModes: [],
  stepNames: [],
  jobs: [],
};

const state = {
  jobs: bootstrap.jobs || [],
  selectedJobId: bootstrap.jobs?.[0]?.id ?? null,
  pollingHandle: null,
  submitStatus: "",
  jobActionStatus: "",
  currentView: "launchpad",
  browserFilter: "all",
  previewCache: {},
  selectedPreviewByJob: {},
  selectedMonitorByJob: {},
};

const jobForm = document.getElementById("job-form");
const profileSelect = document.getElementById("profile-select");
const executionModeSelect = document.getElementById("execution-mode-select");
const customSettings = document.getElementById("custom-settings");
const jobList = document.getElementById("job-list");
const submitButton = document.getElementById("submit-button");
const submitStatus = document.getElementById("submit-status");
const loadSelectedButton = document.getElementById("load-selected-button");
const updateSelectedButton = document.getElementById("update-selected-button");
const topbarStatus = document.getElementById("topbar-status");
const automaticWorkspace = document.getElementById("automatic-workspace");
const manualWorkspace = document.getElementById("manual-workspace");
const workspaceViews = document.querySelectorAll(".workspace-view");
const navChips = document.querySelectorAll("[data-view-target]");

function init() {
  renderProfiles();
  renderExecutionModes();
  bindForm();
  bindInteractions();
  syncCustomVisibility();
  renderJobs();
  renderCurrentView();
  updateTopbarStatus();

  if (state.selectedJobId) {
    loadJob(state.selectedJobId, { preserveView: true });
  }

  state.pollingHandle = setInterval(refreshJobs, 2500);
}

function bindInteractions() {
  profileSelect.addEventListener("change", syncCustomVisibility);
  executionModeSelect.addEventListener("change", handleExecutionModeChange);

  document.addEventListener("click", async (event) => {
    const target = event.target.closest(
      "[data-view-target],[data-job-filter],[data-job-id],[data-quick-mode]," +
        "[data-run-step],[data-run-next],[data-load-job],[data-open-preview]," +
        "[data-select-monitor],[data-open-launchpad]",
    );
    if (!target) {
      return;
    }

    if (target.dataset.viewTarget) {
      setView(target.dataset.viewTarget);
      return;
    }

    if (target.dataset.jobFilter) {
      setBrowserFilter(target.dataset.jobFilter);
      return;
    }

    if (target.dataset.jobId) {
      await loadJob(target.dataset.jobId);
      return;
    }

    if (target.dataset.quickMode) {
      executionModeSelect.value = target.dataset.quickMode;
      handleExecutionModeChange();
      setView("launchpad");
      return;
    }

    const job = getSelectedJob();
    if (!job) {
      return;
    }

    if (target.dataset.runNext !== undefined) {
      const nextStep = getNextRunnableStep(job);
      if (nextStep) {
        await runStep(job.id, nextStep);
      }
      return;
    }

    if (target.dataset.runStep) {
      await runStep(job.id, target.dataset.runStep);
      return;
    }

    if (target.dataset.loadJob !== undefined || target.dataset.openLaunchpad !== undefined) {
      populateFormFromJob(job);
      setSubmitStatus(`Configurazione di ${job.id} caricata nel form.`);
      setView("launchpad");
      return;
    }

    if (target.dataset.openPreview) {
      await selectPreview(job.id, target.dataset.openPreview);
      return;
    }

    if (target.dataset.selectMonitor) {
      selectMonitor(job.id, target.dataset.selectMonitor);
    }
  });
}

function bindForm() {
  jobForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fileInput = jobForm.elements.files;
    if (!fileInput?.files?.length) {
      setSubmitStatus("Seleziona almeno un file input per creare un job.", true);
      return;
    }

    submitButton.disabled = true;
    setSubmitStatus("Creazione job in corso...");

    try {
      const formData = new FormData();
      Array.from(fileInput.files).forEach((file) => formData.append("files", file));
      formData.append("job_payload", JSON.stringify(collectRequestPayload()));

      const response = await fetch("/api/jobs", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ detail: "Errore inatteso" }));
        throw new Error(payload.detail || "Errore inatteso");
      }

      const job = await response.json();
      state.selectedJobId = job.id;
      state.jobActionStatus = "";
      jobForm.reset();
      profileSelect.value = "balanced";
      executionModeSelect.value = "automatic";
      syncCustomVisibility();
      setSubmitStatus(
        job.request.execution_mode === "step_by_step"
          ? `Job ${job.id} creato in modalità step-by-step.`
          : `Job ${job.id} avviato.`,
      );
      await refreshJobs();
      await loadJob(job.id);
    } catch (error) {
      setSubmitStatus(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });

  loadSelectedButton.addEventListener("click", () => {
    const job = getSelectedJob();
    if (!job) {
      setSubmitStatus("Seleziona un job da caricare nel form.", true);
      return;
    }
    populateFormFromJob(job);
    setSubmitStatus(`Configurazione di ${job.id} caricata nel form.`);
    setView("launchpad");
  });

  updateSelectedButton.addEventListener("click", async () => {
    const job = getSelectedJob();
    if (!job) {
      setSubmitStatus("Seleziona un job prima di salvare il tuning.", true);
      return;
    }

    updateSelectedButton.disabled = true;
    setSubmitStatus(`Salvataggio configurazione su ${job.id}...`);

    try {
      const response = await fetch(`/api/jobs/${job.id}/request`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectRequestPayload()),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ detail: "Errore inatteso" }));
        throw new Error(payload.detail || "Errore inatteso");
      }

      const updated = await response.json();
      state.selectedJobId = updated.id;
      setSubmitStatus(`Tuning salvato su ${updated.id}. Ora puoi rilanciare gli step per debug.`);
      await refreshJobs();
      await loadJob(updated.id, { preserveView: true });
    } catch (error) {
      setSubmitStatus(error.message, true);
    } finally {
      updateSelectedButton.disabled = false;
    }
  });
}

function renderProfiles() {
  profileSelect.innerHTML = "";
  bootstrap.profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile;
    option.textContent = profile;
    option.selected = profile === "balanced";
    profileSelect.append(option);
  });
}

function renderExecutionModes() {
  executionModeSelect.innerHTML = "";
  bootstrap.executionModes.forEach((mode) => {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    option.selected = mode === "automatic";
    executionModeSelect.append(option);
  });
}

function handleExecutionModeChange() {
  const view = executionModeSelect.value === "step_by_step" ? "manual" : "automatic";
  setView("launchpad");
  setTopbarStatus(
    view === "manual"
      ? "Modalità manuale: player, preview artefatti, inspector e rerun step-by-step."
      : "Modalità automatica: monitor output, timeline job e control room essenziale.",
  );
}

function setBrowserFilter(filter) {
  state.browserFilter = filter;
  document.querySelectorAll("[data-job-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.jobFilter === filter);
  });
  renderJobs();
}

function setView(view) {
  state.currentView = view;
  navChips.forEach((chip) => chip.classList.toggle("active", chip.dataset.viewTarget === view));
  workspaceViews.forEach((section) => {
    section.classList.toggle("active", section.id === `${view}-view`);
  });
  renderCurrentView();
  updateTopbarStatus();
}

function renderCurrentView() {
  renderAutomaticWorkspace();
  renderManualWorkspace();
}

function renderJobs() {
  jobList.innerHTML = "";
  const jobs = filteredJobs();

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "job-card empty-card";
    empty.innerHTML = `
      <h3>Nessun job</h3>
      <p>La browser rail si popola appena avvii la prima sessione.</p>
    `;
    jobList.append(empty);
    return;
  }

  jobs.forEach((job) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `job-card ${job.id === state.selectedJobId ? "active" : ""}`;
    button.dataset.jobId = job.id;
    button.innerHTML = `
      <div class="job-card-head">
        <div>
          <h3>${escapeHtml(job.title)}</h3>
          <p>${escapeHtml(job.id)}</p>
        </div>
        <span class="tag ${job.status}">${escapeHtml(job.status)}</span>
      </div>
      <div class="job-meta">
        <span class="tag pending">${escapeHtml(job.request.profile)}</span>
        <span class="tag pending">${escapeHtml(job.request.execution_mode)}</span>
        <span class="tag pending">${escapeHtml(job.request.language)}</span>
      </div>
    `;
    jobList.append(button);
  });
}

function renderAutomaticWorkspace() {
  const job = getSelectedJob();
  if (!job) {
    automaticWorkspace.className = "workspace-canvas empty";
    automaticWorkspace.innerHTML = `
      <h2>Auto Room</h2>
      <p>Seleziona un job per vedere monitor, output, step timeline e artifact spotlight.</p>
    `;
    return;
  }

  if (job.request.execution_mode === "step_by_step") {
    automaticWorkspace.className = "workspace-canvas empty";
    automaticWorkspace.innerHTML = `
      <h2>Questo job e' manuale</h2>
      <p>Apri il Manual Studio per lavorare con preview, inspector e rerun step-by-step.</p>
      <button type="button" class="secondary-button" data-view-target="manual">Apri Manual Studio</button>
    `;
    return;
  }

  ensurePreviewDefaults(job);
  const stats = buildJobStats(job);
  const stepCards = renderStepCards(job, { compact: false });
  const outputRack = renderOutputRack(job);
  const artifactRack = renderArtifactRack(job, { limit: 10 });

  automaticWorkspace.className = "workspace-canvas";
  automaticWorkspace.innerHTML = `
    <div class="workspace-header">
      <div>
        <p class="panel-eyebrow">Auto Room</p>
        <h2>${escapeHtml(job.title)}</h2>
        <p class="muted">${escapeHtml(job.id)}${job.error ? ` · ${escapeHtml(job.error)}` : ""}</p>
      </div>
      <div class="inline-actions tight">
        <button type="button" class="secondary-button" data-load-job>Carica config nel form</button>
        <button type="button" class="secondary-button" data-view-target="launchpad">Apri Launchpad</button>
      </div>
    </div>

    <div class="summary-strip">
      ${stats.map((card) => renderSummaryCard(card.label, card.value, card.note)).join("")}
    </div>

    <div class="auto-grid">
      <section class="surface-panel monitor-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Program Monitor</span>
            <h3>Output Preview</h3>
          </div>
          <div class="media-switches">
            ${renderMonitorButtons(job)}
          </div>
        </div>
        ${renderMonitorStage(job)}
      </section>

      <aside class="surface-panel inspector-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Artifact Spotlight</span>
            <h3>Preview</h3>
          </div>
        </div>
        <div class="artifact-toolbar">
          ${artifactRack}
        </div>
        ${renderPreviewPanel(job)}
      </aside>
    </div>

    <div class="detail-grid">
      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Pipeline</span>
            <h3>Step Timeline</h3>
          </div>
        </div>
        <div class="step-column">${stepCards}</div>
      </section>

      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Deliverables</span>
            <h3>Outputs</h3>
          </div>
        </div>
        <div class="artifact-toolbar">${outputRack}</div>
        <div class="log-stack">
          ${(job.logs || [])
            .slice()
            .reverse()
            .map((line) => `<div class="log-card">${escapeHtml(line)}</div>`)
            .join("") || "<p class='muted'>Nessun log disponibile.</p>"}
        </div>
      </section>
    </div>
  `;
}

function renderManualWorkspace() {
  const job = getSelectedJob();
  if (!job) {
    manualWorkspace.className = "workspace-canvas empty";
    manualWorkspace.innerHTML = `
      <h2>Manual Studio</h2>
      <p>Seleziona un job step-by-step per aprire il workspace editoriale con preview di ogni elaborazione.</p>
    `;
    return;
  }

  if (job.request.execution_mode !== "step_by_step") {
    manualWorkspace.className = "workspace-canvas empty";
    manualWorkspace.innerHTML = `
      <h2>Questo job e' automatico</h2>
      <p>Apri l'Auto Room per il monitor sintetico di output, log e timeline.</p>
      <button type="button" class="secondary-button" data-view-target="automatic">Apri Auto Room</button>
    `;
    return;
  }

  ensurePreviewDefaults(job);
  const transcriptCard = renderTranscriptPreview(job);
  const captionsCard = renderCaptionsPreview(job);
  const subtitlesCard = renderSubtitlesPreview(job);
  const timelineCard = renderEditTimeline(job);
  const stepCards = renderStepCards(job, { compact: true });
  const rack = renderArtifactRack(job, { limit: 999 });
  const nextStep = getNextRunnableStep(job);

  manualWorkspace.className = "workspace-canvas";
  manualWorkspace.innerHTML = `
    <div class="workspace-header">
      <div>
        <p class="panel-eyebrow">Manual Studio</p>
        <h2>${escapeHtml(job.title)}</h2>
        <p class="muted">${escapeHtml(job.id)}${job.error ? ` · ${escapeHtml(job.error)}` : ""}</p>
      </div>
      <div class="inline-actions tight">
        <button type="button" data-run-next ${nextStep ? "" : "disabled"}>Esegui prossimo step</button>
        <button type="button" class="secondary-button" data-load-job>Carica config nel form</button>
        <button type="button" class="secondary-button" data-open-launchpad>Apri Launchpad</button>
      </div>
    </div>

    <div class="studio-grid">
      <section class="surface-panel monitor-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Program Monitor</span>
            <h3>Source / Output Preview</h3>
          </div>
          <div class="media-switches">
            ${renderMonitorButtons(job)}
          </div>
        </div>
        ${renderMonitorStage(job)}
      </section>

      <aside class="surface-panel inspector-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Inspector</span>
            <h3>File Preview</h3>
          </div>
          <span class="tag pending">${escapeHtml(state.jobActionStatus || "preview")}</span>
        </div>
        <div class="artifact-toolbar artifact-toolbar-tall">
          ${rack}
        </div>
        ${renderPreviewPanel(job)}
      </aside>
    </div>

    <section class="surface-panel timeline-panel">
      <div class="surface-head">
        <div>
          <span class="surface-eyebrow">Timeline</span>
          <h3>Editorial View</h3>
        </div>
      </div>
      ${timelineCard}
      <div class="step-column compact">${stepCards}</div>
    </section>

    <div class="analysis-grid">
      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Transcript</span>
            <h3>Labeled Words</h3>
          </div>
        </div>
        ${transcriptCard}
      </section>

      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Captions</span>
            <h3>Chunk Preview</h3>
          </div>
        </div>
        ${captionsCard}
      </section>

      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Subtitles</span>
            <h3>ASS Excerpt</h3>
          </div>
        </div>
        ${subtitlesCard}
      </section>

      <section class="surface-panel">
        <div class="surface-head">
          <div>
            <span class="surface-eyebrow">Outputs</span>
            <h3>Media Shelf</h3>
          </div>
        </div>
        <div class="artifact-toolbar">${renderOutputRack(job)}</div>
      </section>
    </div>
  `;
}

function renderMonitorButtons(job) {
  const current = getSelectedMonitor(job);
  return getMonitorSources(job)
    .map((item) => {
      const active = current === item.path;
      return `
        <button
          type="button"
          class="media-pill ${active ? "active" : ""}"
          data-select-monitor="${escapeHtml(item.path)}"
        >${escapeHtml(item.label)}</button>
      `;
    })
    .join("");
}

function renderMonitorStage(job) {
  const selected = getSelectedMonitor(job);
  if (!selected) {
    return `<div class="empty-stage"><p>Nessun media disponibile per il monitor.</p></div>`;
  }

  const type = inferFileType(selected);
  if (type === "audio") {
    return `
      <div class="monitor-stage audio-stage">
        <audio controls preload="metadata" src="${fileUrl(job.id, selected)}"></audio>
        <p class="muted">${escapeHtml(baseName(selected))}</p>
      </div>
    `;
  }

  return `
    <div class="monitor-stage">
      <video controls preload="metadata" src="${fileUrl(job.id, selected)}"></video>
      <p class="muted">${escapeHtml(baseName(selected))}</p>
    </div>
  `;
}

function renderPreviewPanel(job) {
  const path = getSelectedPreview(job);
  if (!path) {
    return `<div class="preview-placeholder"><p>Apri un artifact o un output per vedere il preview.</p></div>`;
  }

  const type = inferFileType(path);
  if (type === "video") {
    return `
      <div class="preview-panel">
        <div class="preview-meta">
          <strong>${escapeHtml(baseName(path))}</strong>
          <a href="${fileUrl(job.id, path)}" target="_blank">Apri file</a>
        </div>
        <video controls preload="metadata" src="${fileUrl(job.id, path)}"></video>
      </div>
    `;
  }

  if (type === "audio") {
    return `
      <div class="preview-panel">
        <div class="preview-meta">
          <strong>${escapeHtml(baseName(path))}</strong>
          <a href="${fileUrl(job.id, path)}" target="_blank">Apri file</a>
        </div>
        <audio controls preload="metadata" src="${fileUrl(job.id, path)}"></audio>
      </div>
    `;
  }

  const entry = getPreviewEntry(job.id, path);
  if (!entry || entry.status === "loading") {
    return `
      <div class="preview-panel">
        <div class="preview-meta">
          <strong>${escapeHtml(baseName(path))}</strong>
          <a href="${fileUrl(job.id, path)}" target="_blank">Apri file</a>
        </div>
        <div class="preview-placeholder"><p>Caricamento preview...</p></div>
      </div>
    `;
  }

  if (entry.status === "error") {
    return `
      <div class="preview-panel">
        <div class="preview-meta">
          <strong>${escapeHtml(baseName(path))}</strong>
          <a href="${fileUrl(job.id, path)}" target="_blank">Apri file</a>
        </div>
        <div class="preview-placeholder"><p>${escapeHtml(entry.message || "Preview non disponibile.")}</p></div>
      </div>
    `;
  }

  const body =
    entry.type === "json"
      ? `<pre>${escapeHtml(JSON.stringify(entry.data, null, 2))}</pre>`
      : `<pre>${escapeHtml(entry.text || "")}</pre>`;

  return `
    <div class="preview-panel">
      <div class="preview-meta">
        <strong>${escapeHtml(baseName(path))}</strong>
        <a href="${fileUrl(job.id, path)}" target="_blank">Apri file</a>
      </div>
      ${renderPreviewSummary(path, entry)}
      ${body}
    </div>
  `;
}

function renderPreviewSummary(path, entry) {
  if (entry.type !== "json" || !entry.data) {
    return "";
  }

  if (path.endsWith("06_edit_decision_list.json")) {
    const ranges = entry.data.keep_ranges || [];
    const cuts = entry.data.soft_cuts || [];
    const keepSeconds = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
    return `
      <div class="summary-strip tiny">
        ${renderSummaryCard("Keep ranges", ranges.length, `${keepSeconds.toFixed(2)}s tenuti`)}
        ${renderSummaryCard("Soft cuts", cuts.length, "Cut marker")}
      </div>
    `;
  }

  if (path.endsWith("07_caption_display.json")) {
    const chunks = entry.data.chunks || [];
    const words = chunks.reduce((sum, chunk) => sum + (chunk.words || []).length, 0);
    return `
      <div class="summary-strip tiny">
        ${renderSummaryCard("Chunks", chunks.length, `${words} parole`)}
      </div>
    `;
  }

  if (path.endsWith("05_spans_labeled.json")) {
    const spans = entry.data.spans || [];
    const counts = spans.reduce((acc, span) => {
      acc[span.label] = (acc[span.label] || 0) + 1;
      return acc;
    }, {});
    return `
      <div class="summary-strip tiny">
        ${Object.entries(counts)
          .map(([label, value]) => renderSummaryCard(label, value, "span"))
          .join("")}
      </div>
    `;
  }

  return "";
}

function renderEditTimeline(job) {
  const edl = getKnownArtifactData(job, "06_edit_decision_list.json");
  const duration = getJobDuration(job);
  if (!edl || !duration) {
    return `<div class="timeline-placeholder"><p>Timeline disponibile dopo l’editorial step.</p></div>`;
  }

  const ranges = edl.keep_ranges || [];
  const cuts = edl.soft_cuts || [];

  return `
    <div class="timeline-track">
      <div class="timeline-ruler">
        <span>0s</span>
        <span>${formatSeconds(duration / 2)}</span>
        <span>${formatSeconds(duration)}</span>
      </div>
      <div class="timeline-lane">
        ${ranges
          .map((range) => {
            const left = (range.start / duration) * 100;
            const width = ((range.end - range.start) / duration) * 100;
            return `
              <button
                type="button"
                class="timeline-segment"
                style="left:${left}%; width:${width}%"
                data-open-preview="${escapeHtml(findArtifactPath(job, "06_edit_decision_list.json") || "")}"
              >
                <span>${escapeHtml(range.reason)}</span>
              </button>
            `;
          })
          .join("")}
        ${cuts
          .map((cut) => {
            const left = (cut.at / duration) * 100;
            return `<span class="timeline-cut" style="left:${left}%"></span>`;
          })
          .join("")}
      </div>
      <div class="timeline-caption-list">
        ${ranges
          .map(
            (range) => `
              <div class="timeline-caption">
                <strong>${formatSeconds(range.start)} → ${formatSeconds(range.end)}</strong>
                <span>${escapeHtml(range.reason)}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTranscriptPreview(job) {
  const spansPayload = getKnownArtifactData(job, "05_spans_labeled.json");
  const transcript = getKnownArtifactData(job, "04_transcript_aligned.json");

  if (spansPayload?.spans?.length) {
    return `
      <div class="word-cloud">
        ${spansPayload.spans
          .slice(0, 48)
          .map(
            (span) => `
              <span class="word-chip ${String(span.label || "").toLowerCase()}">
                ${escapeHtml(span.display_text || span.text)}
                <small>${formatSeconds(span.start)}</small>
              </span>
            `,
          )
          .join("")}
      </div>
    `;
  }

  const words =
    transcript?.segments?.flatMap((segment) => segment.words || []) ||
    [];
  if (!words.length) {
    return `<p class="muted">Nessun transcript disponibile.</p>`;
  }

  return `
    <div class="word-cloud">
      ${words
        .slice(0, 48)
        .map(
          (word) => `
            <span class="word-chip keep">
              ${escapeHtml(word.text)}
              <small>${formatSeconds(word.start)}</small>
            </span>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderCaptionsPreview(job) {
  const captions = getKnownArtifactData(job, "07_caption_display.json");
  const chunks = captions?.chunks || [];
  if (!chunks.length) {
    return `<p class="muted">I caption chunk compariranno qui dopo l’editorial step.</p>`;
  }

  return `
    <div class="chip-list">
      ${chunks
        .map(
          (chunk) => `
            <div class="caption-chip">
              <strong>${escapeHtml((chunk.display_words || []).join(" "))}</strong>
              <span>${formatSeconds(chunk.start)} → ${formatSeconds(chunk.end)}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderSubtitlesPreview(job) {
  const text = getKnownArtifactText(job, "08_subtitles.ass");
  if (!text) {
    return `<p class="muted">Il preview ASS apparira' qui quando il render captioned e' disponibile.</p>`;
  }

  const lines = text
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .slice(0, 8)
    .map((line) => line.replace(/\{[^}]+\}/g, ""))
    .join("\n");

  return `<pre>${escapeHtml(lines)}</pre>`;
}

function renderStepCards(job, options = {}) {
  const compact = options.compact ?? false;
  return (job.steps || [])
    .map((step) => {
      const canRun = canRunStep(job, step.name);
      const actionLabel =
        step.status === "completed" || step.status === "failed" ? "Ripeti step" : "Esegui step";
      const artifacts = (step.artifacts || [])
        .map(
          (artifact) => `
            <button
              type="button"
              class="artifact-pill"
              data-open-preview="${escapeHtml(artifact)}"
            >${escapeHtml(baseName(artifact))}</button>
          `,
        )
        .join("");

      return `
        <div class="step-card ${compact ? "compact" : ""}">
          <div class="step-head">
            <div>
              <strong>${escapeHtml(step.name)}</strong>
              <p>${escapeHtml(step.message || "In attesa")}</p>
            </div>
            <span class="tag ${step.status}">${escapeHtml(step.status)}</span>
          </div>
          <div class="artifact-toolbar">${artifacts || "<span class='muted'>Nessun artifact.</span>"}</div>
          <div class="step-footer">
            <button
              type="button"
              class="secondary-button step-action"
              data-run-step="${escapeHtml(step.name)}"
              ${canRun ? "" : "disabled"}
            >${canRun ? actionLabel : "Prerequisiti mancanti"}</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderArtifactRack(job, options = {}) {
  const limit = options.limit ?? 999;
  return buildArtifactCatalog(job)
    .slice(0, limit)
    .map((item) => {
      const active = getSelectedPreview(job) === item.path;
      return `
        <button
          type="button"
          class="artifact-pill ${active ? "active" : ""}"
          data-open-preview="${escapeHtml(item.path)}"
        >
          <span>${escapeHtml(item.step)}</span>
          <strong>${escapeHtml(baseName(item.path))}</strong>
        </button>
      `;
    })
    .join("");
}

function renderOutputRack(job) {
  return (job.outputs || [])
    .map((path) => {
      const active = getSelectedPreview(job) === path;
      return `
        <button
          type="button"
          class="artifact-pill ${active ? "active" : ""}"
          data-open-preview="${escapeHtml(path)}"
        >
          <span>output</span>
          <strong>${escapeHtml(baseName(path))}</strong>
        </button>
      `;
    })
    .join("") || "<p class='muted'>Nessun output disponibile.</p>";
}

function renderSummaryCard(label, value, note = "") {
  return `
    <div class="summary-card">
      <span>${escapeHtml(String(label))}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <p>${escapeHtml(String(note || ""))}</p>
    </div>
  `;
}

function buildJobStats(job) {
  const mediaProbe = getKnownArtifactData(job, "01_media_probe.json");
  const edl = getKnownArtifactData(job, "06_edit_decision_list.json");
  const captions = getKnownArtifactData(job, "07_caption_display.json");
  const outputs = job.outputs || [];
  const completedSteps = (job.steps || []).filter((step) => step.status === "completed").length;
  const duration = mediaProbe
    ? (mediaProbe.sources || []).reduce((sum, item) => sum + (item.duration_seconds || 0), 0)
    : 0;
  const keepSeconds = edl
    ? (edl.keep_ranges || []).reduce((sum, range) => sum + (range.end - range.start), 0)
    : 0;

  return [
    { label: "Steps", value: `${completedSteps}/${(job.steps || []).length}`, note: job.request.execution_mode },
    { label: "Duration", value: duration ? formatSeconds(duration) : "-", note: "sorgente" },
    { label: "Keep", value: keepSeconds ? formatSeconds(keepSeconds) : "-", note: "EDL" },
    { label: "Outputs", value: outputs.length, note: `${(captions?.chunks || []).length || 0} caption chunks` },
  ];
}

async function runStep(jobId, stepName) {
  state.jobActionStatus = `Avvio ${stepName} su ${jobId}...`;
  updateTopbarStatus();
  renderCurrentView();

  try {
    const response = await fetch(`/api/jobs/${jobId}/steps/${stepName}/run`, {
      method: "POST",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ detail: "Errore inatteso" }));
      throw new Error(payload.detail || "Errore inatteso");
    }

    state.jobActionStatus = `Step ${stepName} avviato.`;
    await refreshJobs();
    setTimeout(() => refreshJobs(), 400);
  } catch (error) {
    state.jobActionStatus = error.message;
    updateTopbarStatus();
    renderCurrentView();
  }
}

async function loadJob(jobId, options = {}) {
  const response = await fetch(`/api/jobs/${jobId}`);
  if (!response.ok) {
    return;
  }
  const job = await response.json();
  state.selectedJobId = job.id;
  state.jobs = upsertJob(job);
  ensurePreviewDefaults(job);
  preloadJobArtifacts(job);

  if (!options.preserveView) {
    const targetView = job.request.execution_mode === "step_by_step" ? "manual" : "automatic";
    setView(targetView);
  } else {
    renderCurrentView();
    updateTopbarStatus();
  }

  renderJobs();
}

async function refreshJobs() {
  const response = await fetch("/api/jobs");
  state.jobs = await response.json();
  renderJobs();

  if (state.selectedJobId) {
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (selected) {
      await loadJob(selected.id, { preserveView: true });
    } else {
      renderCurrentView();
      updateTopbarStatus();
    }
  }
}

function filteredJobs() {
  if (state.browserFilter === "all") {
    return state.jobs;
  }
  return state.jobs.filter((job) => job.request.execution_mode === state.browserFilter);
}

function getSelectedJob() {
  return state.jobs.find((job) => job.id === state.selectedJobId) || null;
}

function ensurePreviewDefaults(job) {
  const previewChoice = state.selectedPreviewByJob[job.id];
  const monitorChoice = state.selectedMonitorByJob[job.id];

  if (!previewChoice) {
    const preferredPreview = preferredPreviewPath(job);
    if (preferredPreview) {
      state.selectedPreviewByJob[job.id] = preferredPreview;
      if (isPreviewableText(preferredPreview)) {
        ensurePreviewLoaded(job.id, preferredPreview);
      }
    }
  }

  if (!monitorChoice) {
    const preferredMonitor = preferredMonitorPath(job);
    if (preferredMonitor) {
      state.selectedMonitorByJob[job.id] = preferredMonitor;
    }
  }
}

function preferredPreviewPath(job) {
  const catalog = buildArtifactCatalog(job);
  const preferred = [
    "06_edit_decision_list.json",
    "07_caption_display.json",
    "05_spans_labeled.json",
    "08_subtitles.ass",
    "09_render_plan.json",
    "04_transcript_aligned.json",
    "03_transcript_raw.json",
    "01_media_probe.json",
  ];
  for (const suffix of preferred) {
    const match = catalog.find((item) => item.path.endsWith(suffix));
    if (match) {
      return match.path;
    }
  }
  return catalog[0]?.path || null;
}

function preferredMonitorPath(job) {
  const sources = getMonitorSources(job);
  if (!sources.length) {
    return null;
  }
  return sources[0].path;
}

async function selectPreview(jobId, path) {
  state.selectedPreviewByJob[jobId] = path;
  if (isPreviewableText(path)) {
    await ensurePreviewLoaded(jobId, path);
  } else if (inferFileType(path) === "video" || inferFileType(path) === "audio") {
    state.selectedMonitorByJob[jobId] = path;
  }
  renderCurrentView();
  updateTopbarStatus();
}

function selectMonitor(jobId, path) {
  state.selectedMonitorByJob[jobId] = path;
  renderCurrentView();
}

function buildArtifactCatalog(job) {
  const items = [];
  (job.steps || []).forEach((step) => {
    (step.artifacts || []).forEach((path) => items.push({ path, step: step.name }));
  });
  (job.outputs || []).forEach((path) => items.push({ path, step: "output" }));
  return uniqueByPath(items);
}

function uniqueByPath(items) {
  const map = new Map();
  items.forEach((item) => {
    if (!map.has(item.path)) {
      map.set(item.path, item);
    }
  });
  return Array.from(map.values());
}

function getMonitorSources(job) {
  const catalog = buildArtifactCatalog(job);
  const preferredOrder = [
    "master_vertical_captioned.mp4",
    "master_vertical_clean.mp4",
    "edited_master.mp4",
    "source_mezzanine.mp4",
    "audio_16k_mono.wav",
  ];
  return preferredOrder
    .map((suffix) => catalog.find((item) => item.path.endsWith(suffix)))
    .filter(Boolean)
    .map((item) => ({
      path: item.path,
      label: humanizeMediaName(item.path),
    }));
}

function preloadJobArtifacts(job) {
  buildArtifactCatalog(job)
    .map((item) => item.path)
    .filter(isPreviewableText)
    .forEach((path) => ensurePreviewLoaded(job.id, path));
}

async function ensurePreviewLoaded(jobId, path) {
  const jobCache = (state.previewCache[jobId] ||= {});
  const existing = jobCache[path];
  if (existing?.status === "ready" || existing?.status === "loading") {
    return;
  }

  const type = inferFileType(path);
  jobCache[path] = { status: "loading", type };
  renderCurrentView();

  try {
    const response = await fetch(fileUrl(jobId, path));
    if (!response.ok) {
      throw new Error("Preview non disponibile.");
    }

    const text = await response.text();
    if (type === "json") {
      jobCache[path] = {
        status: "ready",
        type,
        text,
        data: JSON.parse(text),
      };
    } else {
      jobCache[path] = {
        status: "ready",
        type,
        text,
      };
    }
  } catch (error) {
    jobCache[path] = {
      status: "error",
      type,
      message: error.message,
    };
  }

  renderCurrentView();
}

function getPreviewEntry(jobId, path) {
  return state.previewCache[jobId]?.[path] || null;
}

function getSelectedPreview(job) {
  return state.selectedPreviewByJob[job.id] || null;
}

function getSelectedMonitor(job) {
  return state.selectedMonitorByJob[job.id] || null;
}

function getKnownArtifactData(job, suffix) {
  const path = findArtifactPath(job, suffix);
  return path ? state.previewCache[job.id]?.[path]?.data || null : null;
}

function getKnownArtifactText(job, suffix) {
  const path = findArtifactPath(job, suffix);
  return path ? state.previewCache[job.id]?.[path]?.text || "" : "";
}

function findArtifactPath(job, suffix) {
  return buildArtifactCatalog(job).find((item) => item.path.endsWith(suffix))?.path || null;
}

function getJobDuration(job) {
  const mediaProbe = getKnownArtifactData(job, "01_media_probe.json");
  if (!mediaProbe?.sources?.length) {
    return 0;
  }
  return mediaProbe.sources.reduce((sum, item) => sum + (item.duration_seconds || 0), 0);
}

function canRunStep(job, stepName) {
  if (!job || job.status === "running") {
    return false;
  }

  const index = (job.steps || []).findIndex((step) => step.name === stepName);
  if (index < 0) {
    return false;
  }

  return job.steps.slice(0, index).every((step) => step.status === "completed");
}

function getNextRunnableStep(job) {
  const next = (job.steps || []).find((step) => step.status !== "completed");
  if (!next) {
    return null;
  }
  return canRunStep(job, next.name) ? next.name : null;
}

function collectRequestPayload() {
  const profile = valueOf("profile", "balanced");
  const payload = {
    title: valueOf("title", "Nuovo progetto"),
    profile,
    execution_mode: valueOf("execution_mode", "automatic"),
    language: valueOf("language", "it"),
    editorial_notes: valueOf("editorial_notes", ""),
    toggles: {
      use_whisperx: checked("use_whisperx"),
      use_local_llm: checked("use_local_llm"),
      render_clean: checked("render_clean"),
      render_captioned: checked("render_captioned"),
    },
    subtitle: {
      chunk_words: numberOf("subtitle_chunk_words", 3),
    },
  };

  if (profile === "custom") {
    payload.transcription = {
      model: valueOf("transcription_model", "large-v3"),
      beam_size: numberOf("transcription_beam_size", 5),
      vad_filter: checked("transcription_vad_filter"),
      condition_on_prev_text: checked("transcription_condition_on_prev_text"),
      word_timestamps: checked("transcription_word_timestamps"),
      compute_type: valueOf("transcription_compute_type", "int8"),
      device: valueOf("transcription_device", "auto"),
    };
    payload.subtitle = {
      chunk_words: numberOf("subtitle_chunk_words", 3),
      font_name: valueOf("subtitle_font_name", "Avenir Next"),
      font_size: numberOf("subtitle_font_size", 68),
      text_color: valueOf("subtitle_text_color", "FFFFFF"),
      active_color: valueOf("subtitle_active_color", "73E3FF"),
      outline_color: valueOf("subtitle_outline_color", "101214"),
      bottom_margin: numberOf("subtitle_bottom_margin", 220),
      pop_in_ms: numberOf("subtitle_pop_in_ms", 140),
    };
    payload.render = {
      width: numberOf("render_width", 1080),
      height: numberOf("render_height", 1920),
      video_codec: valueOf("render_video_codec", "libx264"),
      audio_codec: valueOf("render_audio_codec", "aac"),
      crf: numberOf("render_crf", 18),
      preset: valueOf("render_preset", "slow"),
      audio_bitrate: valueOf("render_audio_bitrate", "192k"),
    };
    payload.decision = {
      filler_words: listOf("decision_filler_words"),
      repetition_window_seconds: numberOf("decision_repetition_window_seconds", 0.6),
      soft_pause_threshold_seconds: numberOf("decision_soft_pause_threshold_seconds", 0.25),
      hard_pause_threshold_seconds: numberOf("decision_hard_pause_threshold_seconds", 0.7),
      leading_context_seconds: numberOf("decision_leading_context_seconds", 0.18),
      trailing_context_seconds: numberOf("decision_trailing_context_seconds", 0.18),
      retained_pause_seconds: numberOf("decision_retained_pause_seconds", 0.24),
    };
  }

  return payload;
}

function populateFormFromJob(job) {
  const request = job.request || {};
  setValue("title", request.title || "Nuovo progetto");
  setValue("profile", request.profile || "balanced");
  setValue("execution_mode", request.execution_mode || "automatic");
  setValue("language", request.language || "it");
  setValue("editorial_notes", request.editorial_notes || "");

  setChecked("use_whisperx", request.toggles?.use_whisperx ?? true);
  setChecked("use_local_llm", request.toggles?.use_local_llm ?? false);
  setChecked("render_clean", request.toggles?.render_clean ?? true);
  setChecked("render_captioned", request.toggles?.render_captioned ?? true);

  setValue("transcription_model", request.transcription?.model || "large-v3");
  setValue("transcription_beam_size", request.transcription?.beam_size ?? 5);
  setChecked("transcription_vad_filter", request.transcription?.vad_filter ?? true);
  setChecked(
    "transcription_condition_on_prev_text",
    request.transcription?.condition_on_prev_text ?? false,
  );
  setChecked("transcription_word_timestamps", request.transcription?.word_timestamps ?? true);
  setValue("transcription_compute_type", request.transcription?.compute_type || "int8");
  setValue("transcription_device", request.transcription?.device || "auto");

  setValue("subtitle_chunk_words", request.subtitle?.chunk_words ?? 3);
  setValue("subtitle_font_name", request.subtitle?.font_name || "Avenir Next");
  setValue("subtitle_font_size", request.subtitle?.font_size ?? 68);
  setValue("subtitle_bottom_margin", request.subtitle?.bottom_margin ?? 220);
  setValue("subtitle_pop_in_ms", request.subtitle?.pop_in_ms ?? 140);
  setValue("subtitle_text_color", request.subtitle?.text_color || "FFFFFF");
  setValue("subtitle_active_color", request.subtitle?.active_color || "73E3FF");
  setValue("subtitle_outline_color", request.subtitle?.outline_color || "101214");

  setValue("render_width", request.render?.width ?? 1080);
  setValue("render_height", request.render?.height ?? 1920);
  setValue("render_video_codec", request.render?.video_codec || "libx264");
  setValue("render_audio_codec", request.render?.audio_codec || "aac");
  setValue("render_preset", request.render?.preset || "slow");
  setValue("render_crf", request.render?.crf ?? 18);
  setValue("render_audio_bitrate", request.render?.audio_bitrate || "192k");

  setValue("decision_filler_words", (request.decision?.filler_words || []).join(", "));
  setValue(
    "decision_repetition_window_seconds",
    request.decision?.repetition_window_seconds ?? 0.6,
  );
  setValue(
    "decision_soft_pause_threshold_seconds",
    request.decision?.soft_pause_threshold_seconds ?? 0.25,
  );
  setValue(
    "decision_hard_pause_threshold_seconds",
    request.decision?.hard_pause_threshold_seconds ?? 0.7,
  );
  setValue(
    "decision_leading_context_seconds",
    request.decision?.leading_context_seconds ?? 0.18,
  );
  setValue(
    "decision_trailing_context_seconds",
    request.decision?.trailing_context_seconds ?? 0.18,
  );
  setValue(
    "decision_retained_pause_seconds",
    request.decision?.retained_pause_seconds ?? 0.24,
  );

  syncCustomVisibility();
}

function syncCustomVisibility() {
  customSettings.classList.toggle("hidden", profileSelect.value !== "custom");
}

function updateTopbarStatus() {
  if (state.jobActionStatus) {
    setTopbarStatus(state.jobActionStatus);
    return;
  }

  const job = getSelectedJob();
  if (!job) {
    setTopbarStatus(
      state.submitStatus ||
        "Scegli Automatic o Manual dal Launchpad, poi seleziona un job dalla browser rail.",
    );
    return;
  }

  const viewCopy =
    job.request.execution_mode === "step_by_step"
      ? "Manual Studio attivo: preview artefatti, timeline editoriale e rerun step-by-step."
      : "Auto Room attiva: monitor output, step timeline e deliverable review.";
  setTopbarStatus(viewCopy);
}

function setTopbarStatus(message) {
  topbarStatus.textContent = message;
}

function setSubmitStatus(message, isError = false) {
  state.submitStatus = message;
  submitStatus.textContent = message;
  submitStatus.classList.toggle("error-text", isError);
  updateTopbarStatus();
}

function inferFileType(path) {
  if (/\.(mp4|mov|webm)$/i.test(path)) {
    return "video";
  }
  if (/\.(wav|mp3|aac|m4a)$/i.test(path)) {
    return "audio";
  }
  if (/\.json$/i.test(path)) {
    return "json";
  }
  if (/\.(ass|txt|log)$/i.test(path)) {
    return "text";
  }
  return "binary";
}

function isPreviewableText(path) {
  const type = inferFileType(path);
  return type === "json" || type === "text";
}

function humanizeMediaName(path) {
  if (path.endsWith("master_vertical_captioned.mp4")) {
    return "Captioned";
  }
  if (path.endsWith("master_vertical_clean.mp4")) {
    return "Clean";
  }
  if (path.endsWith("edited_master.mp4")) {
    return "Edited";
  }
  if (path.endsWith("source_mezzanine.mp4")) {
    return "Source";
  }
  if (path.endsWith("audio_16k_mono.wav")) {
    return "Audio";
  }
  return baseName(path);
}

function baseName(path) {
  return String(path).split("/").pop() || path;
}

function formatSeconds(value) {
  return `${Number(value || 0).toFixed(2)}s`;
}

function fileUrl(jobId, relativePath) {
  return `/jobs/${jobId}/files/${encodeURI(relativePath)}`;
}

function upsertJob(job) {
  const existing = state.jobs.find((item) => item.id === job.id);
  if (!existing) {
    return [job, ...state.jobs];
  }
  return state.jobs.map((item) => (item.id === job.id ? job : item));
}

function valueOf(name, fallback = "") {
  const field = jobForm.elements.namedItem(name);
  return field?.value?.trim?.() ? field.value.trim() : fallback;
}

function numberOf(name, fallback) {
  const field = jobForm.elements.namedItem(name);
  const value = Number(field?.value);
  return Number.isFinite(value) ? value : fallback;
}

function checked(name) {
  return Boolean(jobForm.elements.namedItem(name)?.checked);
}

function listOf(name) {
  return valueOf(name, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setValue(name, value) {
  const field = jobForm.elements.namedItem(name);
  if (field) {
    field.value = value;
  }
}

function setChecked(name, value) {
  const field = jobForm.elements.namedItem(name);
  if (field) {
    field.checked = Boolean(value);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

init();
