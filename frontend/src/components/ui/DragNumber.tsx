import { createSignal, Show, type Component } from "solid-js";

const DragNumber: Component<{
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unitsPerPixel?: number;
  snapTargets?: number[];
  snapRadiusPx?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}> = (props) => {
  let inputRef: HTMLInputElement | undefined;
  const [editing, setEditing] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const step = () => props.step ?? 1;
  const unitsPerPixel = () => props.unitsPerPixel ?? step();
  const fmt = () => props.format ?? ((v: number) => {
    const s = step();
    if (s >= 1) return String(Math.round(v));
    if (s >= 0.1) return v.toFixed(1);
    if (s >= 0.01) return v.toFixed(2);
    return v.toFixed(3);
  });
  const clamp = (v: number) => {
    let out = v;
    if (props.min !== undefined) out = Math.max(props.min, out);
    if (props.max !== undefined) out = Math.min(props.max, out);
    return out;
  };
  const snap = (v: number) => {
    const s = step();
    return parseFloat((Math.round(v / s) * s).toFixed(10));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (editing()) return;
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startValue = props.value;
    let last = startValue;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const totalDx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(totalDx) < 3) return;
        moved = true;
        setDragging(true);
        document.body.style.cursor = "ew-resize";
      }
      const raw = startValue + totalDx * unitsPerPixel();
      const snapRadius = (props.snapRadiusPx ?? 6) * unitsPerPixel();
      const targets = props.snapTargets ?? [];
      let snapped = raw;
      for (const t of targets) {
        if (Math.abs(raw - t) <= snapRadius) { snapped = t; break; }
      }
      const next = clamp(snap(snapped));
      if (next !== last) {
        last = next;
        props.onChange(next);
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setDragging(false);
      if (!moved) {
        setDraft(String(props.value));
        setEditing(true);
        setTimeout(() => { inputRef?.focus(); inputRef?.select(); }, 0);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitDraft = () => {
    const v = parseFloat(draft());
    if (!Number.isNaN(v)) props.onChange(clamp(v));
    setEditing(false);
  };

  return (
    <div class={`drag-number${dragging() ? " is-dragging" : ""}`} onMouseDown={onMouseDown}>
      <Show
        when={editing()}
        fallback={<span class="drag-number-value">{fmt()(props.value)}</span>}
      >
        <input
          ref={inputRef}
          class="drag-number-input"
          type="number"
          step={step()}
          value={draft()}
          onMouseDown={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </Show>
    </div>
  );
};

export default DragNumber;
