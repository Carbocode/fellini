import type { Component, JSX } from "solid-js";

const IconButton: Component<{
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  "aria-label"?: string;
  class?: string;
  children: JSX.Element;
}> = (props) => (
  <button
    type="button"
    class={`btn-icon${props.class ? ` ${props.class}` : ""}`}
    onClick={props.onClick}
    aria-label={props["aria-label"]}
  >
    {props.children}
  </button>
);

export default IconButton;
