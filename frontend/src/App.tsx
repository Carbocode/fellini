import { Show, onCleanup, onMount, type Component } from "solid-js";
import TabBar from "./components/TabBar";
import Workspace from "./components/Workspace";
import NewTabPage from "./components/NewTabPage";
import NewProjectDialog from "./components/NewProjectDialog";
import { selectedJobId } from "./store";

const CUSTOM_WHEEL_ZOOM_SELECTOR = ".timeline-ruler-viewport, .timeline-viewport";

function allowsCustomWheelZoom(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CUSTOM_WHEEL_ZOOM_SELECTOR) !== null;
}

const App: Component = () => {
  onMount(() => {
    const listenerOptions: AddEventListenerOptions = { passive: false };
    const preventNativePinchGesture = (event: Event) => {
      event.preventDefault();
    };
    const preventBrowserPinchZoom = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (allowsCustomWheelZoom(event.target)) return;
      event.preventDefault();
    };

    window.addEventListener("wheel", preventBrowserPinchZoom, listenerOptions);
    document.addEventListener("gesturestart", preventNativePinchGesture, listenerOptions);
    document.addEventListener("gesturechange", preventNativePinchGesture, listenerOptions);
    document.addEventListener("gestureend", preventNativePinchGesture, listenerOptions);

    onCleanup(() => {
      window.removeEventListener("wheel", preventBrowserPinchZoom, listenerOptions);
      document.removeEventListener("gesturestart", preventNativePinchGesture, listenerOptions);
      document.removeEventListener("gesturechange", preventNativePinchGesture, listenerOptions);
      document.removeEventListener("gestureend", preventNativePinchGesture, listenerOptions);
    });
  });

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
