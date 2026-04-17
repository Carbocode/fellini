import type { Component, JSX } from "solid-js";

const Textarea: Component<{
  name?: string;
  value?: string;
  placeholder?: string;
  rows?: number | string;
  readonly?: boolean;
  class?: string;
  onInput?: JSX.EventHandlerUnion<HTMLTextAreaElement, InputEvent>;
}> = (props) => (
  <textarea
    name={props.name}
    value={props.value}
    placeholder={props.placeholder}
    rows={props.rows}
    readonly={props.readonly}
    class={props.class}
    onInput={props.onInput}
  />
);

export default Textarea;
