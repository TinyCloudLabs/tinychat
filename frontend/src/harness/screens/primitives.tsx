// The primitives gallery: the palette with its contrast ratios (computed from
// the live CSS variables), the type roles, buttons in each state, segmented
// controls, focus rings and surfaces, in the theme the capture asks for.
import { useState, type ReactNode } from "react";
import { Loader2Icon, MicIcon, PlusIcon, SettingsIcon, SquareIcon } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { contrast, hslTriplet, over, toHex, type Rgb } from "../color";
import type { HarnessScreen } from "../screen";

function token(name: string): Rgb {
  return hslTriplet(getComputedStyle(document.documentElement).getPropertyValue(`--${name}`));
}

function alpha(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${name}`));
}

const ratio = (value: number) => value.toFixed(2);

const SURFACES = [
  { name: "background", label: "Ground", className: "bg-background" },
  { name: "chrome", label: "Chrome", className: "bg-chrome" },
  { name: "card", label: "Card", className: "bg-card" },
  { name: "surface-2", label: "Surface 2", className: "bg-surface-2" },
  { name: "popover", label: "Popover", className: "bg-popover" },
] as const;

const TEXT_ROLES = [
  { name: "foreground", label: "Ink", className: "text-foreground" },
  { name: "muted-foreground", label: "Muted", className: "text-muted-foreground" },
  { name: "primary", label: "Primary", className: "text-primary" },
  { name: "live", label: "Live", className: "text-live" },
  { name: "warning", label: "Warning", className: "text-warning" },
  { name: "destructive", label: "Destructive", className: "text-destructive" },
] as const;

function Section(props: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-headline">{props.title}</h2>
      {props.note && <p className="mt-1 text-meta text-muted-foreground">{props.note}</p>}
      <div className="mt-3">{props.children}</div>
    </section>
  );
}

function Palette() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SURFACES.map((surface) => {
        const bg = token(surface.name);
        return (
          <div key={surface.name} className={cn("rounded-lg border border-border p-3", surface.className)}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-callout font-semibold">{surface.label}</span>
              <span className="tnum text-meta text-muted-foreground">{toHex(bg)}</span>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {TEXT_ROLES.map((role) => (
                <li key={role.name} className="flex items-baseline justify-between gap-2 text-meta">
                  <span className={cn("font-medium", role.className)}>{role.label}</span>
                  <span className="tnum text-muted-foreground">{ratio(contrast(token(role.name), bg))}</span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-2 text-meta">
                <span className="flex items-center gap-2">
                  <span className="h-5 w-8 rounded-sm border border-input" />
                  <span className="text-muted-foreground">Control edge</span>
                </span>
                <span className="tnum text-muted-foreground">{ratio(contrast(token("input"), bg))}</span>
              </li>
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Fills() {
  const fills = [
    { name: "primary", label: "Primary", className: "bg-primary text-primary-foreground" },
    { name: "live", label: "Live", className: "bg-live text-live-foreground" },
    { name: "destructive", label: "Destructive", className: "bg-destructive text-destructive-foreground" },
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {fills.map((fill) => (
        <div key={fill.name} className={cn("flex flex-col gap-0.5 rounded-lg p-3", fill.className)}>
          <span className="text-callout font-semibold">{fill.label}</span>
          <span className="tnum text-meta">
            {toHex(token(fill.name))} · {ratio(contrast(token(`${fill.name}-foreground`), token(fill.name)))}
          </span>
        </div>
      ))}
    </div>
  );
}

function SelectedTints() {
  const tint = alpha("selected-alpha");
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {SURFACES.slice(0, 4).map((surface) => {
        const fill = over(token("primary"), tint, token(surface.name));
        return (
          <div key={surface.name} className={cn("rounded-lg p-1.5", surface.className)}>
            <div className="rounded-md bg-selected px-2.5 py-2">
              <div className="text-callout font-semibold">On {surface.label.toLowerCase()}</div>
              <div className="tnum text-meta text-muted-foreground">
                ink {ratio(contrast(token("foreground"), fill))} · muted {ratio(contrast(token("muted-foreground"), fill))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TYPE_ROLES = [
  { className: "font-display text-timer tnum", spec: "Timer · Literata 48/48 · 500", sample: "12:48" },
  { className: "font-display text-display", spec: "Display · Literata 30/36 · 500", sample: "Think out loud." },
  { className: "font-display text-title-1", spec: "Title 1 · Literata 28/34 · 600", sample: "Capture" },
  { className: "font-display text-title-2", spec: "Title 2 · Literata 20/26 · 600", sample: "Transcription" },
  { className: "text-headline", spec: "Headline · sans 17/22 · 600", sample: "In progress" },
  { className: "text-body", spec: "Body · sans 16/24", sample: "Your conversations are private and stored in your TinyCloud space." },
  { className: "text-callout", spec: "Callout · sans 15/20", sample: "After you stop, TinyCloud Private Transcription turns notes up to 10 minutes into text." },
  { className: "text-meta", spec: "Meta · sans 13/18", sample: "Voice note · 4:12 · 09:41" },
  { className: "text-label", spec: "Label · sans 11/14 · 500", sample: "Connectors" },
] as const;

function TypeScale() {
  return (
    <div className="flex flex-col divide-y divide-border">
      {TYPE_ROLES.map((role) => (
        <div key={role.spec} className="flex flex-col gap-1 py-3">
          <span className="text-meta text-muted-foreground">{role.spec}</span>
          <span className={role.className}>{role.sample}</span>
        </div>
      ))}
    </div>
  );
}

const FOCUS_RING = "ring-2 ring-ring ring-offset-2 ring-offset-background";

const VARIANTS: Array<{ variant: NonNullable<ButtonProps["variant"]>; label: string; icon?: ReactNode }> = [
  { variant: "default", label: "Record", icon: <MicIcon /> },
  { variant: "secondary", label: "Secondary" },
  { variant: "outline", label: "Outline" },
  { variant: "ghost", label: "Ghost" },
  { variant: "link", label: "Link" },
  { variant: "destructive", label: "Discard" },
  { variant: "live", label: "Stop", icon: <SquareIcon className="fill-current" /> },
];

function Buttons() {
  return (
    <div className="flex flex-col gap-4">
      {/* The states stay in columns; with large text the table scrolls inside its own box. */}
      <div className="relative -mx-1 overflow-x-auto px-1 pb-1">
      <div className="grid min-w-[21rem] grid-cols-[repeat(3,minmax(0,1fr))] items-center gap-x-3 gap-y-2">
        {["Rest", "Focus", "Disabled"].map((state) => (
          <span key={state} className="text-meta text-muted-foreground">{state}</span>
        ))}
        {VARIANTS.map(({ variant, label, icon }) => (
          <div key={variant} className="contents">
            <Button variant={variant}>{icon}{label}</Button>
            <Button variant={variant} className={FOCUS_RING}>{icon}{label}</Button>
            <Button variant={variant} disabled>{icon}{label}</Button>
          </div>
        ))}
      </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" variant="outline" aria-label="Settings"><SettingsIcon /></Button>
        <Button disabled><Loader2Icon className="animate-spin motion-reduce:animate-none" />Saving…</Button>
        <Button variant="outline"><PlusIcon />New chat</Button>
      </div>
      <p className="text-meta text-muted-foreground">
        Heights follow the pointer: 44px on touch; 36px (small 32px) with a mouse.
      </p>
    </div>
  );
}

function Segmented() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [route, setRoute] = useState<"off" | "private">("private");
  const [source, setSource] = useState<"upload" | "meeting">("upload");
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        aria-label="Theme"
        value={theme}
        onValueChange={setTheme}
        options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
      />
      <SegmentedControl
        aria-label="Transcription"
        size="compact"
        value={route}
        onValueChange={setRoute}
        options={[{ value: "off", label: "Off" }, { value: "private", label: "Private cloud" }]}
        className="sm:max-w-xs"
      />
      <SegmentedControl
        aria-label="Source"
        size="compact"
        value={source}
        onValueChange={setSource}
        options={[{ value: "upload", label: "Upload" }, { value: "meeting", label: "Meeting", disabled: true }]}
        className="sm:max-w-xs"
      />
    </div>
  );
}

function FocusRings() {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button variant="outline" className={FOCUS_RING}>Button</Button>
      <a href="#focus" data-inline-link className="rounded-sm text-body text-primary underline underline-offset-4 outline outline-2 outline-offset-2 outline-ring">
        Link
      </a>
      <input
        aria-label="Field"
        defaultValue="Field"
        className="h-11 w-36 rounded-md border border-input bg-background px-3 text-body outline outline-2 outline-offset-2 outline-ring fine:h-9 fine:text-sm"
      />
    </div>
  );
}

function Surfaces() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-callout font-semibold">Card</div>
        <p className="mt-1 text-meta text-muted-foreground">A hairline edge in both themes.</p>
      </div>
      <div className="rounded-lg bg-popover p-4 text-popover-foreground shadow-float">
        <div className="text-callout font-semibold">Popover</div>
        <p className="mt-1 text-meta text-muted-foreground">Floating: one tight shadow, no outline.</p>
      </div>
      <div className="rounded-lg bg-chrome p-4">
        <div className="text-callout font-semibold">Chrome</div>
        <p className="mt-1 text-meta text-muted-foreground">Tab bar, rail and sidebar.</p>
      </div>
    </div>
  );
}

function Gallery() {
  const night = document.documentElement.classList.contains("dark");
  return (
    <div className="min-h-full bg-background text-foreground">
      <main className="mx-auto w-full max-w-3xl px-4 pb-12 pt-8 sm:px-6">
        <h1 className="font-display text-title-1">Primitives</h1>
        <p className="mt-2 text-callout text-muted-foreground">
          {night ? "Night" : "Day"}. Ratios are WCAG contrast, computed from the CSS variables on this page.
        </p>
        <Section title="Palette" note="Each role on each surface. Text needs 4.5, a control edge 3.">
          <Palette />
        </Section>
        <Section title="Fills">
          <Fills />
        </Section>
        <Section title="Selected" note="Primary tinted over the surface beneath.">
          <SelectedTints />
        </Section>
        <Section title="Type">
          <TypeScale />
        </Section>
        <Section title="Buttons">
          <Buttons />
        </Section>
        <Section title="Segmented control">
          <Segmented />
        </Section>
        <Section title="Focus rings">
          <FocusRings />
        </Section>
        <Section title="Surfaces">
          <Surfaces />
        </Section>
      </main>
    </div>
  );
}

export const primitivesScreens: HarnessScreen[] = [
  { id: "primitives-gallery", group: "primitives", layout: "document", displayTitle: true, render: () => <Gallery /> },
];
