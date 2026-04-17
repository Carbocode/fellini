import { For, type Component } from "solid-js";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

function SegmentedControl<T extends string = string>(props: {
  options: SegmentOption<T>[];
  value?: T;
  "aria-label"?: string;
  class?: string;
  onChange?: (value: T) => void;
}) {
  return (
    <div
      class={`inspector-segmented${props.class ? ` ${props.class}` : ""}`}
      role="group"
      aria-label={props["aria-label"]}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class={`inspector-segmented__option${props.value === option.value ? " is-active" : ""}`}
            aria-pressed={props.value === option.value}
            disabled={option.disabled}
            onClick={() => props.onChange?.(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

export default SegmentedControl as Component<{
  options: SegmentOption<string>[];
  value?: string;
  "aria-label"?: string;
  class?: string;
  onChange?: (value: string) => void;
}>;
