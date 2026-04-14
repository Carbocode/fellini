import { For, Show, createMemo, type Component } from "solid-js";
import { IconFolders, IconLogs } from "@tabler/icons-solidjs";
import {
  useEditorialProjectQuery,
  useJobQuery,
} from "../api/queries";
import { selectedJobId, selectedTrackId } from "../store";
import { getTrack, isAudioTrack } from "../lib/editorial";
import { capitalize } from "../lib/utils";

export type ToolStep = "editorial" | "render";
type SidebarView = "assets" | "logs";

interface PipelineBarProps {
  assetCount: number;
  logCount: number;
  onSidebarSegmentSelect: (view: SidebarView) => void;
  sidebarOpen: boolean;
  sidebarView: SidebarView;
  activeToolSidebar: ToolStep | null;
  onToolSelect: (step: ToolStep) => void;
}

const TOOL_CONFIG: Array<{ step: ToolStep; label: string; hint: string }> = [
  {
    step: "editorial",
    label: "Editorial",
    hint: "Aggiorna il montaggio dalla story lane",
  },
  {
    step: "render",
    label: "Render",
    hint: "Esporta il montaggio finale del progetto",
  },
];

const PipelineBar: Component<PipelineBarProps> = (props) => {
  const job = useJobQuery(selectedJobId);
  const project = useEditorialProjectQuery(selectedJobId);

  const selectedAudioLane = createMemo(() => {
    const currentProject = project.data ?? null;
    if (!currentProject) return null;
    const lane = getTrack(currentProject, selectedTrackId());
    return isAudioTrack(lane) ? lane : null;
  });

  const stepSnapshot = (name: ToolStep) =>
    (job.data?.steps ?? []).find((step) => step.name === name) ?? null;

  const runningStep = createMemo(
    () => (job.data?.steps ?? []).find((step) => step.status === "running") ?? null,
  );

  const canUseTool = () => !!job.data && job.data.status !== "running";

  const storyLane = createMemo(() =>
    project.data?.tracks.find((track) => track.kind === "audio" && track.role === "story") ?? null,
  );

  const toolMeta = (name: ToolStep) => {
    if (name !== "editorial") return "";
    return storyLane() ? `Story lane: ${storyLane()!.name}` : "Story lane richiesta";
  };

  const buttonLabel = (name: ToolStep) =>
    runningStep()?.name === name
      ? "In esecuzione..."
      : TOOL_CONFIG.find((tool) => tool.step === name)?.label ?? capitalize(name);

  const sidebarTabActive = (view: SidebarView) => props.sidebarOpen && props.sidebarView === view;
  const sidebarTabTitle = (view: SidebarView) =>
    sidebarTabActive(view)
      ? `Chiudi sidebar ${view === "assets" ? "media" : "log"}`
      : `Apri ${view === "assets" ? "media" : "log"} nella sidebar`;

  return (
    <div class="pipeline-bar">
      <button
        type="button"
        class={`pipeline-sidebar-tab${sidebarTabActive("assets") ? " active" : ""}`}
        title={sidebarTabTitle("assets")}
        onClick={() => props.onSidebarSegmentSelect("assets")}
      >
        <IconFolders />
        <span class="pipeline-sidebar-tab-label">Media</span>
        <span class="pipeline-sidebar-tab-badge">{props.assetCount}</span>
      </button>
      <button
        type="button"
        class={`pipeline-sidebar-tab${sidebarTabActive("logs") ? " active" : ""}`}
        title={sidebarTabTitle("logs")}
        onClick={() => props.onSidebarSegmentSelect("logs")}
      >
        <IconLogs />
        <span class="pipeline-sidebar-tab-label">Log</span>
        <span class="pipeline-sidebar-tab-badge">{props.logCount}</span>
      </button>
      <div class="pipeline-status">
        <Show
          when={runningStep()}
          fallback={
            <span class="pipeline-status-text">
              {selectedAudioLane()
                ? `Lane attiva: ${selectedAudioLane()!.name}`
                : storyLane()
                  ? `Story lane: ${storyLane()!.name}`
                  : "Seleziona una story lane audio"}
            </span>
          }
        >
          {(step) => (
            <span class="pipeline-status-text">
              {capitalize(step().name)} in esecuzione
              <Show when={step().progress > 0}>
                <> {Math.round(step().progress)}%</>
              </Show>
            </span>
          )}
        </Show>
      </div>
      <For each={TOOL_CONFIG}>
        {(tool) => {
          const snapshot = () => stepSnapshot(tool.step);
          return (
            <button
              type="button"
              class={`pipeline-tool ${snapshot()?.status ?? "pending"}${props.activeToolSidebar === tool.step ? " active" : ""}`}
              disabled={!canUseTool()}
              title={snapshot()?.blocked_reason || `${tool.hint}${tool.step === "editorial" ? ` | ${toolMeta(tool.step)}` : ""}`}
              onClick={() => props.onToolSelect(tool.step)}
            >
              <span class="pipeline-tool-head">
                <span class="pipeline-tool-dot" />
                <span class="pipeline-tool-label">{buttonLabel(tool.step)}</span>
              </span>
              <Show when={snapshot()?.progress && snapshot()!.progress > 0 && snapshot()!.progress < 100}>
                <span class="pipeline-tool-progress">{Math.round(snapshot()!.progress)}%</span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
};

export default PipelineBar;
