// The chat header's microphone. While a recording is starting or running it is not drawn: the recorder, its
// minimised bar and the live chip are the way back to it, and a second microphone beside them only adds noise.
import { RecordButton } from "./RecordButton";
import { useRecorder } from "./RecorderProvider";

export function HeaderRecordButton() {
  const { phase } = useRecorder();
  if (phase === "starting" || phase === "recording") return null;
  return <RecordButton variant="icon" />;
}
