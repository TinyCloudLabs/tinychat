import type { FC, ReactNode } from "react";

const TINFOIL_FAQ_URL = "https://tinfoil.sh/security-and-privacy-faq";
const TINFOIL_PRIVACY_URL = "https://tinfoil.sh/privacy";

/**
 * What private cloud transcription does with a recording (plan §5: separate
 * claims for PTX, Tinfoil and TinyChat; nothing "verified" or "end-to-end").
 * Shared by Exo Local on the desktop and voice notes on the phone, which
 * differ only in the opening paragraph and where the original recording stays.
 */
export const PrivateCloudDisclosure: FC<{ intro: ReactNode; originalStays: ReactNode }> = ({ intro, originalStays }) => (
  <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
    <p>{intro}</p>
    <ul className="list-disc space-y-1 pl-4">
      <li>
        TinyCloud Private Transcription deletes the audio once transcription finishes or fails. It deletes the
        text transcript when this app has saved it to your TinyCloud space; otherwise the transcript is
        scheduled for deletion 24 hours after transcription. Deleted data is no longer available through the
        service but may remain on its storage media until overwritten. It receives an anonymous account
        identifier, not your wallet address.
      </li>
      <li>
        Tinfoil processes the segments inside hardware enclaves. It states that it does not retain request or
        response content after responding, and it keeps billing and usage metadata. See Tinfoil&apos;s{" "}
        <a href={TINFOIL_FAQ_URL} target="_blank" rel="noopener noreferrer" className="underline">
          security FAQ
        </a>{" "}
        and{" "}
        <a href={TINFOIL_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">
          privacy policy
        </a>
        .
      </li>
      <li>
        TinyChat&apos;s server authorizes the upload and relays status and the transcript text back to this
        app. It never receives your audio.
      </li>
      <li>{originalStays}</li>
    </ul>
  </div>
);
