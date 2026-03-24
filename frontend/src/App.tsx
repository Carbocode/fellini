import { Show, type Component } from "solid-js";
import TabBar from "./components/TabBar";
import Workspace from "./components/Workspace";
import NewTabPage from "./components/NewTabPage";
import NewProjectDialog from "./components/NewProjectDialog";
import { selectedJobId } from "./store";

const App: Component = () => {
  return (
    <div class="app">
      <TabBar />
      <div class="app-body">
        <Show when={selectedJobId()} fallback={<NewTabPage />}>
          <Workspace />
        </Show>
      </div>
      <NewProjectDialog />
    </div>
  );
};

export default App;
