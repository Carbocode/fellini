import { For, type Component } from "solid-js";
import { IconMovie, IconPlus, IconX } from "@tabler/icons-solidjs";
import {
  tabs,
  activeTabIdx,
  setActiveTabIdx,
  openTab,
  closeTab,
  setAboutDialogOpen,
} from "../store";

const TabBar: Component = () => {
  return (
    <div class="tab-bar">
      <button
        type="button"
        class="tab-bar-logo"
        title="About Fellini"
        aria-label="Apri About Fellini"
        onClick={() => setAboutDialogOpen(true)}
      >
        <IconMovie />
        <span>Fellini</span>
      </button>
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
                <IconX size={13} />
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
          <IconPlus size={14} />
        </button>
      </div>
    </div>
  );
};

export default TabBar;
