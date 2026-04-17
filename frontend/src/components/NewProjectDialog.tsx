import { createSignal, Show, type Component } from "solid-js";
import { IconX } from "@tabler/icons-solidjs";
import { useCreateJobMutation } from "../api/queries";
import { dialogOpen, selectProjectInTab, setDialogOpen } from "../store";
import { Button, IconButton, FormField, Input, Select, Textarea } from "./ui";

const CANVAS_PRESETS = [
  { id: "vertical", label: "Vertical", width: 1080, height: 1920 },
  { id: "landscape", label: "Landscape", width: 1920, height: 1080 },
  { id: "square", label: "Square", width: 1080, height: 1080 },
  { id: "hd-vertical", label: "Vertical HD", width: 720, height: 1280 },
] as const;

function evenDimension(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.max(256, Math.round(parsed));
  return normalized % 2 === 0 ? normalized : normalized + 1;
}

const NewProjectDialog: Component = () => {
  const createJob = useCreateJobMutation();
  const [error, setError] = createSignal("");
  const [presetId, setPresetId] = createSignal<(typeof CANVAS_PRESETS)[number]["id"]>("vertical");
  const [canvasWidth, setCanvasWidth] = createSignal("1080");
  const [canvasHeight, setCanvasHeight] = createSignal("1920");
  let formRef: HTMLFormElement | undefined;

  const applyPreset = (id: (typeof CANVAS_PRESETS)[number]["id"]) => {
    const preset = CANVAS_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setPresetId(id);
    setCanvasWidth(String(preset.width));
    setCanvasHeight(String(preset.height));
  };

  const close = () => {
    setDialogOpen(false);
    setError("");
    formRef?.reset();
    applyPreset("vertical");
  };

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();

    const form = formRef!;
    const val = (name: string, fb: string) =>
      (form.elements.namedItem(name) as HTMLInputElement)?.value?.trim() || fb;

    const width = evenDimension(canvasWidth(), 1080);
    const height = evenDimension(canvasHeight(), 1920);
    const payload = {
      title: val("title", "Nuovo progetto"),
      language: val("language", "it"),
      editorial_notes: val("editorial_notes", ""),
      render: {
        width,
        height,
      },
    };

    const formData = new FormData();
    formData.append("job_payload", JSON.stringify(payload));

    try {
      const job = await createJob.mutateAsync(formData);
      selectProjectInTab(job.id, job.title);
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
            <IconButton onClick={close}>
              <IconX size={16} />
            </IconButton>
          </div>
          <form ref={formRef} onSubmit={onSubmit}>
            <div class="dialog-body">
              <div class="form-row">
                <FormField label="Titolo">
                  <Input name="title" value="Nuovo progetto" required />
                </FormField>
                <FormField label="Lingua">
                  <Input name="language" value="it" />
                </FormField>
              </div>
              <div class="form-row">
                <FormField label="Canvas">
                  <Select
                    value={presetId()}
                    onInput={(e) =>
                      applyPreset(e.currentTarget.value as (typeof CANVAS_PRESETS)[number]["id"])
                    }
                  >
                    {CANVAS_PRESETS.map((preset) => (
                      <option value={preset.id}>
                        {preset.label} {preset.width}×{preset.height}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <div class="form-row" style={{ "grid-template-columns": "1fr 1fr" }}>
                  <FormField label="Width">
                    <Input
                      type="number"
                      min="256"
                      step="2"
                      value={canvasWidth()}
                      onInput={(e) => setCanvasWidth(e.currentTarget.value)}
                    />
                  </FormField>
                  <FormField label="Height">
                    <Input
                      type="number"
                      min="256"
                      step="2"
                      value={canvasHeight()}
                      onInput={(e) => setCanvasHeight(e.currentTarget.value)}
                    />
                  </FormField>
                </div>
              </div>
              <FormField label="Note editoriali">
                <Textarea
                  name="editorial_notes"
                  rows="2"
                  placeholder="Tone, hook, istruzioni di taglio..."
                />
              </FormField>
            </div>
            <div class="dialog-footer">
              <span class={`dialog-status${error() ? " error" : ""}`}>
                {error() || (createJob.isPending ? "Creazione in corso..." : "")}
              </span>
              <Button variant="ghost" onClick={close}>
                Annulla
              </Button>
              <Button
                type="submit"
                disabled={createJob.isPending}
              >
                Crea progetto
              </Button>
            </div>
          </form>
        </div>
      </div>
    </Show>
  );
};

export default NewProjectDialog;
