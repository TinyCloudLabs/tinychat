// How it works (/chat/about, TC-761): the explanations the screens used to
// carry inline. Screens keep a short label, a one-line InfoTip, and a
// HowItWorksLink to one of these sections; `lib/about.ts` owns the ids and
// titles, this file the words. Every claim here is one the app already made on
// its screens or in its disclosures: this page moves copy, it never adds
// promises.
import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { ABOUT_SECTIONS, type AboutSectionId } from "@/lib/about";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";

/** A link to another section of this page, on its own line (a 44 px target on touch). */
function See(props: { section: AboutSectionId }) {
  const title = ABOUT_SECTIONS.find((section) => section.id === props.section)?.title ?? props.section;
  return (
    <HowItWorksLink section={props.section} className="-my-2 w-fit fine:my-0">
      {title}
    </HowItWorksLink>
  );
}

function Sub(props: { children: ReactNode }) {
  return <h3 className="pt-2 text-body font-semibold text-foreground">{props.children}</h3>;
}

function List(props: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{props.children}</ul>;
}

/** Each section's text, keyed by its id, so a section in lib/about.ts cannot ship without words. */
export const ABOUT_BODY: Readonly<Record<AboutSectionId, ReactNode>> = {
  capture: (
    <>
      <p>Exo records audio in two ways.</p>
      <List>
        <li>
          <strong className="font-semibold">Voice notes</strong>, in the phone app. A note can run up to 60 minutes; the
          recorder stops at the limit. It is saved to your TinyCloud space and shows up in Library. While Exo records,
          your phone shows its microphone indicator and a notification.
        </li>
        <li>
          <strong className="font-semibold">Local recording</strong>, in the desktop app. It records this Mac’s microphone
          and meeting audio, and transcribes after you stop.
        </li>
      </List>
      <See section="transcription" />
    </>
  ),
  transcription: (
    <>
      <p>
        You choose how each recording or upload becomes text. In Settings you pick the default engine for uploaded
        audio; you can still pick the other engine for each upload.
      </p>
      <Sub>Private cloud</Sub>
      <p>
        Your audio is uploaded over an encrypted connection to TinyCloud Private Transcription, a dedicated confidential
        virtual machine on Phala Cloud. It sends short speech segments to Tinfoil for speech-to-text. Tinfoil processes
        the segments inside hardware enclaves. It states that it does not retain request or response content after
        responding, and it keeps billing and usage metadata.
      </p>
      <List>
        <li>TinyCloud Private Transcription deletes the audio once transcription finishes or fails.</li>
        <li>
          It deletes the text transcript when this app has saved it to your TinyCloud space; otherwise the transcript is
          scheduled for deletion 24 hours after transcription. Deleted data is no longer available through the service
          but may remain on its storage media until overwritten.
        </li>
        <li>It receives an anonymous account identifier, not your wallet address.</li>
        <li>
          TinyChat’s server authorizes the upload and relays status and the transcript text back to this app. It never
          receives your audio.
        </li>
      </List>
      <p>Private cloud takes voice notes up to 10 minutes, and uploads and desktop recordings up to 2 hours.</p>
      <Sub>On this Mac</Sub>
      <p>
        The desktop app can transcribe a local recording on-device with Whisper instead. Nothing leaves the machine until
        the transcript is saved to your space. Whisper runs after you stop, not live.
      </p>
      <Sub>AssemblyAI, for uploads</Sub>
      <List>
        <li>
          With TinyCloud’s AssemblyAI account (the default, no key needed), your file goes to Exo’s server (a
          confidential VM on Phala Cloud), which sends it to AssemblyAI under TinyCloud’s account and AssemblyAI’s
          terms. Exo deletes it at AssemblyAI after saving the transcript to your TinyCloud space.
        </li>
        <li>
          With your own API key, the file goes from this device to AssemblyAI under your key and AssemblyAI’s terms; it
          does not pass through TinyChat’s server. The key is kept in your encrypted TinyCloud secrets. To delete a
          finished transcript at AssemblyAI, Exo’s server forwards the key there once; it never stores or logs it.
        </li>
        <li>AssemblyAI is not part of TinyCloud’s private transcription.</li>
      </List>
      <Sub>The original audio</Sub>
      <p>
        A voice note’s audio stays in your TinyCloud space, with its transcript saved next to it. An upload keeps a copy
        of the original file in your space, next to its transcript. A local recording stays on this Mac.
      </p>
    </>
  ),
  notetaker: (
    <>
      <p>
        Paste a meeting link and a TinyCloud notetaker joins the call. When the meeting ends, the speaker-attributed
        transcript is saved to your TinyCloud space and shows up in Library.
      </p>
      <p>
        If the notetaker hears no one else for five minutes, it ends automatically. You can end it immediately from the
        meeting row. With Google Meet connected, calendar autojoin can send it for you.
      </p>
      <See section="connectors" />
    </>
  ),
  uploads: (
    <>
      <p>
        Transcribe a recording you already have. The transcript and a copy of the original file are saved to your
        TinyCloud space and show up in Library.
      </p>
      <p>
        Private transcription and TinyCloud’s AssemblyAI account take MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio, up to
        2 hours. With your own AssemblyAI key, most audio and video files work. Where the
        file goes depends on the engine you choose.
      </p>
      <See section="transcription" />
    </>
  ),
  library: (
    <>
      <p>
        Library holds everything your connected sources have synced into your private space, along with your voice
        notes, uploads and notetaker transcripts.
      </p>
      <p>
        Meetings a connector has stored for this account are there on any device you sign in to. You do not need the
        device that set the connector up.
      </p>
    </>
  ),
  connectors: (
    <>
      <p>
        Connectors bring meeting notes and transcripts into your private space. You choose each source, when it syncs,
        and when its access ends. Synced data is stored in your space.
      </p>
      <Sub>Background notifications</Sub>
      <p>
        Optional, for each connector that offers them: the connector tells us the moment a meeting is ready. You paste a
        delivery address and a signing secret into its webhook settings. The secret is shown only once.
      </p>
      <p>
        Lost the signing secret? Rotating issues a new address and secret. The old ones stop working immediately and have
        to be replaced in the connector’s webhook settings.
      </p>
      <Sub>Calendar autojoin</Sub>
      <p>
        A notetaker joins confirmed Google Meet events on your primary calendar when you organize or accept them, from
        one minute before start until five minutes after start or the event ends. The host still needs to admit it.
      </p>
      <p>
        It works while TinyChat is closed. Recordings import when you return and unlock your space. Turning it off
        removes the server’s saved Google token and requests stops for active autojoined bots; Google’s granted
        permissions and your browser importer remain.
      </p>
    </>
  ),
  "agent-access": (
    <>
      <p>
        Agent access controls private agent memory and meeting access. Public web search stays available without it.
      </p>
      <p>
        Connecting asks you once to authorize access: you sign with your passkey, or sign in with OpenKey where passkeys
        aren’t available. Access can expire or fail to verify; the app then asks you to reconnect. You can disconnect at
        any time in Settings.
      </p>
      <p>
        To use your space from your own agent, copy the prompt in Settings into it and sign in with your TinyChat account
        when prompted.
      </p>
    </>
  ),
  "your-data": (
    <>
      <p>
        Your conversations live in your TinyCloud space, and so do your transcripts, synced meetings and what the
        assistant remembers. Voice notes are saved there, and so is a copy of each file you upload. The audio of a
        desktop local recording stays on that Mac.
      </p>
      <p>
        The assistant’s memory is a document in your space. You can edit or clear it at any time in Settings; clearing
        or resetting it cannot be undone.
      </p>
      <p>You can also bring your Claude conversation history into your space, from Settings.</p>
    </>
  ),
  verification: (
    <>
      <p>Each reply carries one of three verification badges.</p>
      <List>
        <li>
          <strong className="font-semibold">Response verified</strong>: the model’s Intel TDX quote is verified on-chain,
          and the reply carries a valid signature that binds it to the enclave.
        </li>
        <li>
          <strong className="font-semibold">Enclave attested</strong>: the endpoint is a genuine Intel TDX enclave, but the
          model does not sign individual responses, so the reply is not cryptographically bound to the enclave.
        </li>
        <li>
          <strong className="font-semibold">Not verifiable</strong>: the model didn’t return a verifiable on-chain
          attestation. Confidential models that publish an Intel TDX quote can be verified.
        </li>
      </List>
      <Sub>The backend</Sub>
      <p>
        Settings checks TinyChat’s own backend from your browser. It verifies the TDX quote (relayed via Phala and
        anchored trustlessly on-chain), binds the backend identity to a fresh nonce, and replays the served code
        measurement. The status turns Backend attested only when all three legs pass. Today the compose leg can’t fully
        bind (the backend doesn’t serve the app-compose file yet), so it stays at Quote issued until that deploy lands.
      </p>
      <p>
        This proves the endpoint and code identity, not each response byte. You can check the same evidence yourself on
        Phala’s explorer, the Phala trust center and TinyCloud’s evidences page, linked from the details in Settings.
      </p>
    </>
  ),
};

/**
 * The section an address's hash names, or null for none: no hash, an unknown
 * id, or a malformed escape (`#%E0%A4%A`), which opens the page at the top.
 */
export function sectionFromHash(hash: string): AboutSectionId | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  return ABOUT_SECTIONS.find((section) => section.id === id)?.id ?? null;
}

/**
 * The page. Pushed over the app at every size (Back returns where the user came
 * from); mounted only while shown. Opening it at `#<section>` scrolls that
 * section to the top and focuses its heading, so a screen reader starts there.
 */
export function AboutPage(props: { onBack: () => void }) {
  const { hash } = useLocation();
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = sectionFromHash(hash);
    const heading = id === null ? null : document.getElementById(`about-${id}-heading`);
    if (!heading) {
      scrollerRef.current?.scrollTo({ top: 0 });
      return;
    }
    heading.closest("section")?.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [hash]);

  return (
    <div ref={scrollerRef} className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title="How it works" back={props.onBack} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} pb-[max(2rem,env(safe-area-inset-bottom))]`}>
        {ABOUT_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`about-${section.id}-heading`}
            data-about-section={section.id}
            className="scroll-mt-16 border-t border-border pb-2 pt-8 first:border-t-0 first:pt-4"
          >
            <h2 id={`about-${section.id}-heading`} tabIndex={-1} className="text-headline text-foreground outline-none">
              {section.title}
            </h2>
            <div className="mt-3 flex max-w-[65ch] flex-col gap-3 text-body text-foreground">{ABOUT_BODY[section.id]}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
