import type { Component, JSX } from "solid-js";

const Toggle: Component<{
  label: string;
  checked?: boolean;
  class?: string;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event>;
}> = (props) => (
  <label class={`toggle${props.class ? ` ${props.class}` : ""}`}>
    <input
      type="checkbox"
      checked={props.checked}
      onChange={props.onChange}
    />
    <span>{props.label}</span>
  </label>
);

export default Toggle;
