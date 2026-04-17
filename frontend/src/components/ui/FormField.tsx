import type { Component, JSX } from "solid-js";

export type FormFieldVariant = "default" | "compact";

const FormField: Component<{
  label: string;
  variant?: FormFieldVariant;
  full?: boolean;
  class?: string;
  children: JSX.Element;
}> = (props) => {
  const cls = () => {
    const base = props.variant === "compact" ? "param-field" : "form-field";
    const parts = [base];
    if (props.full) parts.push("full");
    if (props.class) parts.push(props.class);
    return parts.join(" ");
  };

  return (
    <label class={cls()}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
};

export default FormField;
