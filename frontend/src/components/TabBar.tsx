import { For, type Component } from "solid-js";
import { tabs, activeTabIdx, setActiveTabIdx, openTab, closeTab } from "../store";

const TabBar: Component = () => {
  return (
    <div class="tab-bar">
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
