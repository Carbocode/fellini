import type { Component, JSX } from "solid-js";

const Select: Component<{
  value?: string;
  class?: string;
  onInput?: JSX.EventHandlerUnion<HTMLSelectElement, InputEvent>;
  onChange?: JSX.EventHandlerUnion<HTMLSelectElement, Event>;
  children: JSX.Element;
}> = (props) => (
  <select
    value={props.value}
    class={props.class}
    onInput={props.onInput}
    onChange={props.onChange}
  >
    {props.children}
  </select>
);

export default Select;
