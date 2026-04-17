import { Show, type Component, type JSX } from "solid-js";
import { IconChevronRight } from "@tabler/icons-solidjs";

const InspectorAccordion: Component<{
  icon: JSX.Element;
  title: string;
  meta?: string;
  open?: boolean;
  class?: string;
  children?: JSX.Element;
}> = (props) => (
  <details class={`inspector-accordion${props.class ? ` ${props.class}` : ""}`} open={props.open}>
    <summary class="inspector-accordion-summary">
      <div class="inspector-accordion-head">
        <span class="inspector-accordion-symbol" aria-hidden="true">{props.icon}</span>
        <div class="inspector-accordion-copy">
          <span class="inspector-accordion-title">{props.title}</span>
          <Show when={props.meta}>
            <span class="inspector-accordion-meta">{props.meta}</span>
          </Show>
        </div>
      </div>
      <span class="inspector-accordion-caret" aria-hidden="true"><IconChevronRight /></span>
    </summary>
    <div class="inspector-accordion-body">{props.children}</div>
  </details>
);

export default InspectorAccordion;
