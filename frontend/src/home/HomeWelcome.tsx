// The signed-out front page: a house at night with the lights on. Your feed, chats, recordings, notes, apps and
// connections are its six lit rooms, seen first from across the street (shapes behind glass), then up close
// (sample content, labelled as such; the Feed room is the real demo feed a visitor can answer), and the way in
// is the one warm thing on the page: the door. Styles in landing.css.
//
// Direction (impeccable seed 3485f387). THESIS: all your data lives here and you are about to see it, so the page
// is a home with the lights on, not a feature tour. OWN-WORLD: night ground, periwinkle window light, warm lamp
// light for the door and primary action only, Instrument Serif and Geist outside, the app's own light theme
// inside every window. FIRST VIEWPORT: headline, Open, and the house whose windows flick on one room at a time.
// SIGNATURE: the door standing ajar, opening wider on hover and wide while signing in. MOTION: lights only,
// lit by default, nothing under prefers-reduced-motion.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowDownIcon, BadgeCheckIcon, CompassIcon, KeyRoundIcon, Share2Icon } from "lucide-react";

import { BuildInfoLine } from "@/components/BuildInfoLine";
import type { AppState } from "@/lib/appState";
import { errorLinkFor } from "@/lib/authErrors";
import { APP_NAME } from "@/lib/homeSite";
import {
  APPS_CONNECTORS_DESCRIPTION, WELCOME_DEMO_NOTE, WELCOME_LEAD, WELCOME_LEARN_MORE, WELCOME_LEARN_MORE_LEAD, WELCOME_TITLE,
} from "@/lib/homeStrings";
import { bootMessage } from "@/shell/BootSurface";
import { AgentPromptCard } from "./AgentPromptCard";
import { HomeDemoFeed } from "./demoFeed";
import "./landing.css";

const MAC_DOWNLOAD_URL = "https://github.com/TinyCloudLabs/tinychat/releases?q=exo-desktop&expanded=true";
const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/UrtvpNMn";
const NIGHT = "#07070D";

type RoomId = "feed" | "chat" | "recordings" | "notes" | "apps" | "connections";

/** The six rooms, in the order their lights come on. `shapes` is what shows through the glass from far away. */
const ROOMS: { id: RoomId; name: string; line: string; delay: number; shapes: CSSProperties[] }[] = [
  { id: "feed", name: "Feed", line: "What your agents, and the people you allow, share with you.", delay: 150,
    shapes: [{ inset: "0 0 70% 0" }, { inset: "36% 0 34% 0" }, { inset: "72% 0 0 0" }] },
  { id: "chat", name: "Chat", line: "Talk with an agent about your data, with private inference when you want it.", delay: 620,
    shapes: [{ inset: "4% 0 72% 30%", borderRadius: 9 }, { inset: "36% 24% 34% 0", borderRadius: 9 }, { inset: "74% 0 2% 44%", borderRadius: 9 }] },
  { id: "recordings", name: "Recordings", line: "Record or upload a meeting and get its transcript, saved in your own space.", delay: 380,
    shapes: [18, 46, 80, 58, 96, 40, 66, 24].map((height, index) => ({ left: `${index * 13}%`, width: "8%", top: `${(100 - height) / 2}%`, height: `${height}%` })) },
  { id: "notes", name: "Notes", line: "Record a thought on the go. It's saved in your TinyCloud.", delay: 1040,
    shapes: [{ inset: "2% 34% 84% 0" }, { inset: "30% 0 62% 0" }, { inset: "48% 8% 44% 0" }, { inset: "66% 0 26% 0" }, { inset: "84% 40% 8% 0" }] },
  { id: "apps", name: "Apps", line: "Secrets, Credentials, Explorer and the other TinyCloud apps, one tap away.", delay: 820,
    shapes: [{ inset: "4% 54% 56% 0", borderRadius: 8 }, { inset: "4% 0 56% 54%", borderRadius: 8 }, { inset: "56% 54% 4% 0", borderRadius: 8 }, { inset: "56% 0 4% 54%", borderRadius: 8 }] },
  { id: "connections", name: "Connections", line: APPS_CONNECTORS_DESCRIPTION, delay: 1320,
    shapes: [{ inset: "8% 0 70% 0", borderRadius: 99 }, { inset: "40% 0 38% 0", borderRadius: 99 }, { inset: "72% 0 6% 0", borderRadius: 99 }] },
];

const WAVE = [22, 38, 64, 30, 82, 54, 96, 44, 70, 26, 58, 88, 40, 72, 34, 92, 50, 28, 66, 84, 36, 60, 24, 76, 46, 90, 32, 56, 80, 42, 68, 20, 52, 74, 30, 48];

const sample = <span className="tcl-sample">Sample</span>;

/** What each room shows up close. All of it is made up, and says so. */
const INTERIORS: Record<Exclude<RoomId, "feed">, ReactNode> = {
  chat: <>
    {sample}
    <div className="tcl-chat">
      <p className="tcl-bubble tcl-bubble-me">What did we decide about the launch date?</p>
      <p className="tcl-bubble tcl-bubble-them">On Tuesday's call you settled on the 14th. Mara has the checklist.</p>
      <p className="tcl-bubble tcl-bubble-me">Put it in my Feed on Monday.</p>
    </div>
  </>,
  recordings: <>
    {sample}
    <p className="tcl-rec-head"><span>Weekly sync</span><span>42:07</span></p>
    <div className="tcl-wave" aria-hidden>{WAVE.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
    <p className="tcl-line"><b>Me</b><span>Let's lock the date before Friday.</span></p>
    <p className="tcl-line"><b>Them</b><span>Friday works. I'll send the list tonight.</span></p>
  </>,
  notes: <>
    {sample}
    <p className="tcl-note-title">Idea on the walk home</p>
    <p className="tcl-note-meta">Voice note, 0:48</p>
    <p className="tcl-note-body">What if the weekly summary was a card in the Feed instead of an email? Ask the research agent to try it.</p>
  </>,
  apps: <>
    {sample}
    <div className="tcl-tiles">
      <span className="tcl-tile"><KeyRoundIcon aria-hidden />Secrets</span>
      <span className="tcl-tile"><BadgeCheckIcon aria-hidden />Credentials</span>
      <span className="tcl-tile"><CompassIcon aria-hidden />Explorer</span>
      <span className="tcl-tile"><Share2Icon aria-hidden />Share</span>
    </div>
  </>,
  connections: <>
    {sample}
    <p className="tcl-conn">Google Meet<span>Connected</span></p>
    <p className="tcl-conn">Fireflies<span>Connected</span></p>
  </>,
};

const calm = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function HomeWelcome({ state, error, onSignIn }: { state: AppState; error: string | null; onSignIn: () => void }) {
  const busy = state === "connecting" || state === "signing";
  const errorLink = error ? errorLinkFor(error) : null;
  const page = useRef<HTMLDivElement>(null);

  // The browser's own chrome joins the night while this page is up.
  useEffect(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const before = metas.map((meta) => meta.content);
    for (const meta of metas) meta.content = NIGHT;
    return () => metas.forEach((meta, index) => { meta.content = before[index]; });
  }, []);

  // Up close, a room's light comes on as the visitor reaches it. Lit is the default: without the observer,
  // or with reduced motion, nothing is ever dark.
  useEffect(() => {
    const root = page.current;
    if (!root || calm() || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-lit", "");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.3 });
    root.setAttribute("data-dim", "");
    for (const room of root.querySelectorAll(".tcl-room")) observer.observe(room);
    return () => {
      observer.disconnect();
      root.removeAttribute("data-dim");
    };
  }, []);

  const walkTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
  const open = busy ? "Opening…" : `Open ${APP_NAME}`;
  const availability = (
    <>
      Live on the web.{" "}
      <a className="tcl-link" href={MAC_DOWNLOAD_URL} target="_blank" rel="noreferrer">Download for Mac.</a>{" "}
      <a className="tcl-link" href={IOS_TESTFLIGHT_URL} target="_blank" rel="noreferrer">iOS in TestFlight.</a>
    </>
  );

  return (
    <div ref={page} className="tcl">
      <header className="tcl-top">
        <span className="tcl-mark"><img src="/icons/pwa-192.png" alt="" width={28} height={28} />{WELCOME_TITLE}</span>
        <button type="button" className="tcl-btn tcl-btn-ghost" disabled={busy} onClick={onSignIn}>Sign in</button>
      </header>

      <section className="tcl-hero">
        <div className="tcl-hero-copy">
          <h1>Everything of yours <em>lives here.</em></h1>
          <p className="tcl-lead">Your feed, chats, recordings, notes and apps, kept in one space that is yours. The lights are on. Come in.</p>
          <div className="tcl-cta">
            <button type="button" className="tcl-btn tcl-btn-lamp" disabled={busy} onClick={onSignIn}>{open}</button>
            <button type="button" className="tcl-peek" onClick={() => walkTo("inside")}>Look through the windows<ArrowDownIcon aria-hidden className="size-4" /></button>
          </div>
          {(busy || error) && <p role="status" className="tcl-status">{bootMessage(state, error)}</p>}
          {errorLink && <a href={errorLink.href} target="_blank" rel="noreferrer" className="tcl-link">{errorLink.label}</a>}
          <p className="tcl-avail">{availability}</p>
        </div>
        <div className="tcl-house">
          <div className="tcl-windows">
            {ROOMS.map((room) => (
              <button key={room.id} type="button" className="tcl-win" style={{ "--d": `${room.delay}ms` } as CSSProperties} onClick={() => walkTo(`room-${room.id}`)}>
                <span className="tcl-win-spill" aria-hidden />
                <span className="tcl-win-glass" aria-hidden>
                  <span className="tcl-win-light"><span className="tcl-glimpse">{room.shapes.map((shape, index) => <i key={index} style={shape} />)}</span></span>
                </span>
                <span className="tcl-win-name">{room.name}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section id="inside" className="tcl-inside tcl-wrap" aria-labelledby="tcl-inside-title">
        <h2 id="tcl-inside-title" className="tcl-h2">Come closer. <em>Look inside.</em></h2>
        <p className="tcl-sub">Six rooms in one space. What's in these windows is sample content. Yours is behind the door.</p>
        <div className="tcl-rooms">
          {ROOMS.map((room) => (
            <article key={room.id} id={`room-${room.id}`} className={`tcl-room tcl-room-${room.id}`}>
              <div className="tcl-pane tcl-interior">
                {room.id === "feed" ? <>{sample}<HomeDemoFeed /></> : INTERIORS[room.id]}
              </div>
              <div className="tcl-placard">
                <h3>{room.name}</h3>
                <p>{room.line}{room.id === "feed" && ` ${WELCOME_DEMO_NOTE}`}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="tcl-key tcl-wrap" aria-labelledby="tcl-key-title">
        <div className="tcl-key-copy">
          <h2 id="tcl-key-title" className="tcl-h2">Your key. <em>Your space.</em></h2>
          <p className="tcl-sub">{WELCOME_LEAD}</p>
          <ul className="tcl-truths">
            <li>Sign in with a passkey, Apple, Google or an email code.</li>
            <li>Agents get only the access you allow.</li>
            <li>You can remove an agent's access at any time.</li>
          </ul>
        </div>
        <div className="tcl-key-agent tcl-pane tcl-interior"><AgentPromptCard /></div>
      </section>

      <section className="tcl-ground" aria-labelledby="tcl-ground-title">
        <div className="tcl-door" aria-hidden data-open={busy ? "" : undefined} onClick={busy ? undefined : onSignIn}>
          <div className="tcl-doorway"><div className="tcl-door-slab" /></div>
          <div className="tcl-pool" />
        </div>
        <h2 id="tcl-ground-title" className="tcl-h2">It's all in there. <em>Come in.</em></h2>
        <button type="button" className="tcl-btn tcl-btn-lamp" disabled={busy} onClick={onSignIn}>{open}</button>
        <p className="tcl-avail">{availability}</p>
      </section>

      <footer className="tcl-foot">
        <p>{WELCOME_LEARN_MORE_LEAD}{" "}<a href="https://tinycloud.xyz" className="tcl-link">{WELCOME_LEARN_MORE}</a></p>
        <BuildInfoLine />
      </footer>
    </div>
  );
}
