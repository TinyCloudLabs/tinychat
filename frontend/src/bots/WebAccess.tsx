// Main's web access setting (off by default), shown in Main's chat sheet. Everything the service sends back is
// rendered as plain text. The site-list check here is a hint for the owner; the service enforces the same rules.
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BotsError, type BotsApi, type MainWebMode, type MainWebSettings } from "./botsApi";
import { BOTS_STRINGS, WEB_ACCESS_STRINGS as COPY } from "./botsStrings";

export type WebAccessApi = Pick<BotsApi, "getMainWeb" | "setMainWeb">;

const MAX_HOSTS = 50;
const MAX_HOST_LENGTH = 253;
const MODES: readonly MainWebMode[] = ["off", "listed", "any"];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A site name like docs.example.com: ASCII labels, at least two, no scheme, path, port or IP address, and not localhost. */
function isHostname(host: string): boolean {
  if (host.length > MAX_HOST_LENGTH) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^[0-9]+$/.test(labels[labels.length - 1]!);
}

/** The sites in a one-per-line list, lowercased and de-duplicated; null when the list is empty, too long or has a bad line. */
export function parseHosts(text: string): string[] | null {
  const hosts = [...new Set(text.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean))];
  return hosts.length > 0 && hosts.length <= MAX_HOSTS && hosts.every(isHostname) ? hosts : null;
}

/** The warning shown before web access is turned on or widened to any site. */
function needsWarning(from: MainWebMode, to: MainWebMode): boolean {
  return (from === "off" && to !== "off") || (from === "listed" && to === "any");
}

interface Target {
  mode: MainWebMode;
  hosts: string[];
}

function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-muted-foreground">
      <p>{text}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {BOTS_STRINGS.tryAgain}
      </Button>
    </div>
  );
}

function Warning({ mode, onConfirm, onCancel }: { mode: MainWebMode; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p id={`${id}-title`} className="text-headline">{COPY.warningTitle}</p>
      <div className="flex flex-col gap-2 text-callout text-muted-foreground">
        <p id={`${id}-body`}>{COPY.warningFace}</p>
        <details>
          <summary className="cursor-pointer">{COPY.warningLearnMore}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>{COPY.warningBody}</p>
            {mode === "any" ? <p>{COPY.warningBodyAny}</p> : null}
          </div>
        </details>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onConfirm}>{COPY.warningConfirm}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>{COPY.warningCancel}</Button>
      </div>
    </div>
  );
}

export function WebAccess({ api }: { api: WebAccessApi }) {
  const id = useId();
  const [saved, setSaved] = useState<MainWebSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<MainWebMode>("off");
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<{ target: Target; invalid: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    api.getMainWeb(controller.signal).then(
      (settings) => {
        if (controller.signal.aborted) return;
        setSaved(settings);
        setMode(settings.mode);
        setText(settings.hosts.join("\n"));
      },
      () => { if (!controller.signal.aborted) setLoadFailed(true); },
    );
    return () => controller.abort();
  }, [api, attempt]);

  if (!saved) {
    return (
      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3" data-bots-web-access="">
        <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
        {loadFailed ? <Failure text={COPY.loadFailed} onRetry={() => setAttempt((count) => count + 1)} /> : null}
      </section>
    );
  }

  const unavailable = !saved.available;
  const busy = saving || confirming !== null;
  const hosts = mode === "listed" ? parseHosts(text) : saved.hosts;
  const changed = mode !== saved.mode || (mode === "listed" && (hosts === null || hosts.join("\n") !== saved.hosts.join("\n")));
  const listError = mode === "listed" && touched && hosts === null;
  const usage = saved.mode === "off" ? "" : COPY.usageLine(saved.today);

  const choose = (next: MainWebMode) => {
    setMode(next);
    setConfirming(null);
    setFailed(null);
  };

  const save = async (target: Target) => {
    setConfirming(null);
    setFailed(null);
    setSaving(true);
    try {
      const stored = await api.setMainWeb(target);
      if (!alive.current) return;
      setSaved(stored);
      setMode(stored.mode);
      setText(stored.hosts.join("\n"));
      setTouched(false);
    } catch (error) {
      if (!alive.current) return;
      // The service kept the old setting, so the old one stays selected.
      setMode(saved.mode);
      setFailed({ target, invalid: error instanceof BotsError && error.code === "invalid" });
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const submit = () => {
    if (hosts === null) {
      setTouched(true);
      return;
    }
    const target = { mode, hosts };
    if (needsWarning(saved.mode, mode)) setConfirming(target);
    else void save(target);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4" data-bots-web-access="">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
        {saved.mode === "off" ? <p className="text-callout text-muted-foreground">{COPY.offDescription}</p> : null}
        {unavailable ? <p className="text-callout text-muted-foreground">{COPY.unavailable}</p> : null}
        {usage ? <p className="text-callout text-muted-foreground">{usage}</p> : null}
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && changed) submit();
        }}
      >
        <fieldset disabled={saving} className="flex flex-col gap-1 border-0 p-0">
          <legend className="sr-only">{COPY.title}</legend>
          {MODES.map((preset) => {
            const disabled = unavailable && preset !== "off";
            return (
              <label
                key={preset}
                className={`flex items-start gap-3 rounded-xl px-1 py-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}
              >
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={preset}
                  checked={mode === preset}
                  disabled={disabled || confirming !== null}
                  onChange={() => choose(preset)}
                  aria-describedby={`${id}-${preset}`}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body">{COPY.presets[preset].label}</span>
                  <span id={`${id}-${preset}`} className="text-callout text-muted-foreground">{COPY.presets[preset].description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {mode === "listed" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-callout">{COPY.listLabel}</span>
            <textarea
              value={text}
              onChange={(event) => { setText(event.target.value); setFailed(null); }}
              onBlur={() => setTouched(true)}
              placeholder={COPY.listPlaceholder}
              disabled={busy}
              rows={4}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-invalid={listError}
              aria-describedby={`${id}-list-hint${listError ? ` ${id}-list-error` : ""}`}
              className="block w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span id={`${id}-list-hint`} className="text-callout text-muted-foreground">{COPY.listHint}</span>
            {listError ? <span id={`${id}-list-error`} role="alert" className="text-callout text-destructive">{COPY.listError}</span> : null}
          </label>
        ) : null}
        {confirming ? <Warning mode={confirming.mode} onConfirm={() => void save(confirming)} onCancel={() => choose(saved.mode)} /> : (
          <div>
            <Button type="submit" disabled={!changed || saving}>{saving ? COPY.saving : COPY.save}</Button>
          </div>
        )}
        {failed ? (
          failed.invalid ? <p role="alert" className="text-callout text-muted-foreground">{COPY.listError}</p> : (
            <Failure text={COPY.saveFailed} onRetry={() => void save(failed.target)} />
          )
        ) : null}
      </form>
    </section>
  );
}
