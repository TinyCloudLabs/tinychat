// TC-3195: who shared a recording, from the owner's signature. In sentences, the short address, never broken across
// lines; under the headline, the whole address to compare with one the sender gave you, marked when this Library
// has nothing else from that address.
import { fullAddress, shortAddress } from "@/lib/nativeShares/display";

export function Sender(props: { address: string }) {
  return <span className="whitespace-nowrap">{shortAddress(props.address)}</span>;
}

export function SenderAddress(props: { address: string; firstShare: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 text-meta text-muted-foreground" data-testid="sender-address">
      <span>Sender address</span>
      <span className="font-mono [overflow-wrap:anywhere]">{fullAddress(props.address)}</span>
      {props.firstShare && <span className="mt-1 self-start rounded-sm bg-surface-2 px-1.5 py-0.5" data-testid="first-share">First share from this sender</span>}
    </div>
  );
}
