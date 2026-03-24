import { createSignal, Show, type Component } from "solid-js";
import { useCreateJobMutation, useConfigQuery } from "../api/queries";
import {
  dialogOpen,
  setDialogOpen,
  selectProjectInTab,
  setSelectedStep,
} from "../store";

const NewProjectDialog: Component = () => {
  const config = useConfigQuery();
  const createJob = useCreateJobMutation();
  const [error, setError] = createSignal("");
  let formRef: HTMLFormElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  const [fileLabel, setFileLabel] = createSignal("");

  const close = () => {
    setDialogOpen(false);
    setError("");
    setFileLabel("");
    formRef?.reset();
  };

  const onFileChange = () => {
    const files = fileInputRef?.files;
    if (!files || files.length === 0) setFileLabel("");
    else if (files.length === 1) setFileLabel(files[0].name);
    else setFileLabel(`${files.length} file selezionati`);
  };

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!fileInputRef?.files?.length) {
      setError("Seleziona almeno un file sorgente.");
      return;
    }

    const form = formRef!;
    const val = (name: string, fb: string) =>
      (form.elements.namedItem(name) as HTMLInputElement)?.value?.trim() || fb;
    const chk = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement)?.checked ?? false;

    const payload = {
      title: val("title", "Nuovo progetto"),
      profile: val("profile", "balanced"),
      execution_mode: val("execution_mode", "automatic"),
      language: val("language", "it"),
      editorial_notes: val("editorial_notes", ""),
      toggles: {
        use_whisperx: chk("use_whisperx"),
        use_local_llm: chk("use_local_llm"),
        render_clean: chk("render_clean"),
        render_captioned: chk("render_captioned"),
      },
    };

    const formData = new FormData();
    for (const file of Array.from(fileInputRef.files)) {
      formData.append("files", file);
    }
    formData.append("job_payload", JSON.stringify(payload));

    try {
      const job = await createJob.mutateAsync(formData);
      selectProjectInTab(job.id, job.title);
      setSelectedStep(null);
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Errore nella creazione");
    }
  };

  return (
    <Show when={dialogOpen()}>
      <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div class="dialog">
          <div class="dialog-header">
            <h2>Nuovo progetto</h2>
            <button type="button" class="btn-icon" onClick={close}>
              &times;
            </button>
          </div>
          <form ref={formRef} onSubmit={onSubmit}>
            <div class="dialog-body">
              <div class="form-row">
                <label class="form-field">
                  <span>Titolo</span>
                  <input type="text" name="title" value="Nuovo progetto" required />
                </label>
                <label class="form-field">
                  <span>Lingua</span>
                  <input type="text" name="language" value="it" />
                </label>
              </div>
              <div class="form-row">
                <label class="form-field">
                  <span>Profilo</span>
                  <select name="profile">
                    {(config.data?.profiles ?? ["fast", "balanced", "quality", "custom"]).map(
                      (p) => (
                        <option value={p} selected={p === "balanced"}>
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label class="form-field">
                  <span>Esecuzione</span>
                  <select name="execution_mode">
                    {(config.data?.execution_modes ?? ["automatic", "step_by_step"]).map(
                      (m) => (
                        <option value={m} selected={m === "automatic"}>
                          {m === "step_by_step" ? "Step-by-step" : "Automatic"}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <label class="form-field">
                <span>File sorgente</span>
                <div class="dropzone">
                  <input
                    ref={fileInputRef}
                    type="file"
                    name="files"
                    multiple
                    onChange={onFileChange}
                  />
                  <p>
                    Trascina i file qui oppure <strong>sfoglia</strong>
                  </p>
                  <Show when={fileLabel()}>
                    <span class="dropzone-info">{fileLabel()}</span>
                  </Show>
                </div>
              </label>
              <label class="form-field">
                <span>Note editoriali</span>
                <textarea
                  name="editorial_notes"
                  rows="2"
                  placeholder="Tone, hook, istruzioni di taglio..."
                />
              </label>
              <div class="toggle-row">
                <label class="toggle">
                  <input type="checkbox" name="use_whisperx" checked />
                  <span>WhisperX</span>
                </label>
                <label class="toggle">
                  <input type="checkbox" name="use_local_llm" />
                  <span>LLM locale</span>
                </label>
                <label class="toggle">
                  <input type="checkbox" name="render_clean" checked />
                  <span>Export clean</span>
                </label>
                <label class="toggle">
                  <input type="checkbox" name="render_captioned" checked />
                  <span>Export captioned</span>
                </label>
              </div>
            </div>
            <div class="dialog-footer">
              <span class={`dialog-status${error() ? " error" : ""}`}>
                {error() || (createJob.isPending ? "Creazione in corso..." : "")}
              </span>
              <button type="button" class="btn btn-ghost" onClick={close}>
                Annulla
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                disabled={createJob.isPending}
              >
                Crea progetto
              </button>
            </div>
          </form>
        </div>
      </div>
    </Show>
  );
};

export default NewProjectDialog;
