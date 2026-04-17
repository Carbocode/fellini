import { Show, type Component, type JSX } from "solid-js";

export type InfoRowVariant = "inspector" | "debug";

/**
 * Label-value row used in inspector cards and monitor debug panels.
 * - `inspector` (default): renders both sides as `<span>`, class `inspector-card-row`
 * - `debug`: renders label as `<span>`, value as `<strong>`, class `monitor-debug-row`
 *
 * For complex values (multi-expression, formatted markup), pass children instead of `value`.
 * For stacked layout (long code paths), use `stack` prop.
 */
const InfoRow: Component<{
  label: string;
  value?: string | number | boolean | null;
  variant?: InfoRowVariant;
  stack?: boolean;
  code?: boolean;
  class?: string;
  children?: JSX.Element;
}> = (props) => {
  const isDebug = () => props.variant === "debug";

  const baseCls = () => {
    if (isDebug()) return "monitor-debug-row";
    let cls = "inspector-card-row";
    if (props.stack) cls += " inspector-card-row--stack";
    return cls;
  };

  const cls = () => {
    const base = baseCls();
    return props.class ? `${base} ${props.class}` : base;
  };

  const renderValue = () => {
    if (props.children !== undefined) return props.children;

    const display = props.value === null || props.value === undefined
      ? ""
      : typeof props.value === "boolean"
        ? (props.value ? "Yes" : "No")
        : String(props.value);

    if (isDebug()) return <strong>{display}</strong>;
    if (props.code) return <span class="inspector-card-value--code">{display}</span>;
    return <span>{display}</span>;
  };

  return (
    <div class={cls()}>
      <span>{props.label}</span>
      {renderValue()}
    </div>
  );
};

export default InfoRow;
