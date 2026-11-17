// TC-3195: who shared a recording, as the owner's short address (from the owner's signature), never broken across
// lines.
import { shortAddress } from "@/lib/nativeShares/display";

export function Sender(props: { address: string }) {
  return <span className="whitespace-nowrap">{shortAddress(props.address)}</span>;
}
