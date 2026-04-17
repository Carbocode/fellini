import type { Component, JSX } from "solid-js";

const Input: Component<{
  type?: "text" | "number";
  name?: string;
  value?: string | number;
  placeholder?: string;
  required?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  class?: string;
  onInput?: JSX.EventHandlerUnion<HTMLInputElement, InputEvent>;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event>;
}> = (props) => (
  <input
    type={props.type ?? "text"}
    name={props.name}
    value={props.value as string | undefined}
    placeholder={props.placeholder}
    required={props.required}
    min={props.min}
    max={props.max}
    step={props.step}
    class={props.class}
    onInput={props.onInput}
    onChange={props.onChange}
  />
);

export default Input;
