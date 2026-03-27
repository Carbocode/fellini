import { For, type Component } from "solid-js";
import { tabs, activeTabIdx, setActiveTabIdx, openTab, closeTab } from "../store";

const TabBar: Component = () => {
  return (
    <div class="tab-bar">
      <div class="tab-bar-logo">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5" />
          <path d="M10 9l5 3-5 3V9z" fill="currentColor" opacity="0.8" />
          <circle cx="6" cy="8" r="1.2" fill="currentColor" opacity="0.5" />
        </svg>
        <span>Fellini</span>
      </div>
      <div class="tab-list">
        <For each={tabs()}>
          {(tab, i) => (
            <div
              class={`tab${i() === activeTabIdx() ? " active" : ""}`}
              onClick={() => setActiveTabIdx(i())}
            >
              <span class="tab-label">{tab.label}</span>
              <button
                type="button"
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(i());
                }}
              >
                &times;
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="tab-new"
          title="Nuova tab"
          onClick={() => openTab(null)}
        >
          +
        </button>
      </div>
    </div>
  );
};

export default TabBar;
