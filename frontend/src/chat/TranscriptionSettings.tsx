// Default for audio imported into Exo. Powerful always uses Exo's server account.
import { useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AudioLinesIcon } from "lucide-react";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SectionCard } from "@/components/ui/section-card";
import { readDefaultUploadEngine, writeDefaultUploadEngine, type UploadEngine } from "@/lib/audioUpload";
import { POWERFUL_NOT_PRIVATE_LINE, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";

const SEGMENT = "min-h-11 rounded px-3 py-1 text-xs fine:min-h-0";

export const TranscriptionSettings: FC<{ tcw: TinyCloudWeb }> = () => {
  const [engine, setEngine] = useState<UploadEngine>(readDefaultUploadEngine);
  return (
    <SectionCard icon={AudioLinesIcon} title="Transcription">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center text-xs text-muted-foreground">
          Default engine for uploaded audio
          <InfoTip label="About the default engine" className="-my-3 fine:-my-1">You can still pick the other engine for each upload.</InfoTip>
        </span>
        <div role="radiogroup" aria-label="Default transcription engine" className="inline-flex w-fit rounded-md border p-0.5">
          {(["private-cloud", "assemblyai"] as const).map((next) => (
            <button key={next} type="button" role="radio" aria-checked={engine === next}
              onClick={() => { setEngine(next); writeDefaultUploadEngine(next); }}
              className={`${SEGMENT} ${engine === next ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {TRANSCRIBER_NAME[next]}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{POWERFUL_NOT_PRIVATE_LINE}</p>
      <HowItWorksLink section="transcription" className="mt-2 w-fit" />
    </SectionCard>
  );
};
