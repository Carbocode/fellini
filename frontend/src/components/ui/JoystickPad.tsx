import { createSignal, type Component } from "solid-js";

const JoystickPad: Component<{
  getValue: () => { x: number; y: number };
  onSet: (x: number, y: number) => void;
}> = (props) => {
  const [handlePos, setHandlePos] = createSignal({ x: 0, y: 0 });
  const [active, setActive] = createSignal(false);
  const PAD = 56;
  const SNAP_RADIUS = 6;

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setActive(true);
    const start = props.getValue();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;

    const onMove = (ev: MouseEvent) => {
      const totalDx = ev.clientX - startMouseX;
      const totalDy = ev.clientY - startMouseY;
      setHandlePos({
        x: Math.max(-PAD, Math.min(PAD, totalDx)),
        y: Math.max(-PAD, Math.min(PAD, totalDy)),
      });
      let nx = start.x + totalDx;
      let ny = start.y + totalDy;
      if (Math.abs(nx) <= SNAP_RADIUS) nx = 0;
      if (Math.abs(ny) <= SNAP_RADIUS) ny = 0;
      props.onSet(nx, ny);
    };

    const onUp = () => {
      setActive(false);
      setHandlePos({ x: 0, y: 0 });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      class={`joystick-pad${active() ? " is-active" : ""}`}
      onMouseDown={onMouseDown}
      title="Trascina per spostare la clip"
    >
      <div class="joystick-crosshair joystick-crosshair--h" />
      <div class="joystick-crosshair joystick-crosshair--v" />
      <div
        class="joystick-handle"
        style={{ transform: `translate(calc(-50% + ${handlePos().x}px), calc(-50% + ${handlePos().y}px))` }}
      />
    </div>
  );
};

export default JoystickPad;
