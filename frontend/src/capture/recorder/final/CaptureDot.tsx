import { useCaptureDot } from "./MinimizedProvider";
import "./ribbon.css";

/** Red while capturing, grey while paused, hollow when interrupted or waiting on the user. */
export function CaptureDot() {
  const dot = useCaptureDot();
  if (dot === null) return null;
  return (
    <>
      <span
        data-testid="capture-dot"
        data-dot={dot.kind}
        className="capture-dot"
        aria-hidden="true"
      />
      <span className="sr-only">, {dot.status.toLowerCase()}</span>
    </>
  );
}
