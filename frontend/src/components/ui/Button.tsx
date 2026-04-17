import type { Component, JSX } from "solid-js";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md";

const Button: Component<{
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit";
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children: JSX.Element;
}> = (props) => {
  const cls = () => {
    const parts = ["btn"];
    parts.push(`btn-${props.variant ?? "primary"}`);
    const size = props.size ?? "md";
    if (size !== "md") parts.push(`btn-${size}`);
    if (props.class) parts.push(props.class);
    return parts.join(" ");
  };

  return (
    <button
      type={props.type ?? "button"}
      class={cls()}
      disabled={props.disabled}
      aria-label={props["aria-label"]}
      aria-pressed={props["aria-pressed"]}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
};

export default Button;
