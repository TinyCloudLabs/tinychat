// Settings → card.md: the owner edits how agents make cards for their Feed. Save stores it and gives every connected
// agent the new version (cardMd.ts); Reset to default only fills the editor, so nothing changes until Save.
import { useCallback, useEffect, useState } from "react";
import { FileTextIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { cardMdDatabase, ensureCardMdSeeded, readCardMd, saveCardMd, syncCardMd, type CardMd } from "./cardMd";
import { CARD_MD_DEFAULT } from "./cardMdDefault";
import { CARD_MD_STRINGS } from "./strings";

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; stored: CardMd };

export function CardMdSettings({ tcw }: { tcw: TinyCloudWeb }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const read = useCallback(() => {
    setLoad({ state: "loading" });
    let current = true;
    // Started inside a promise, so a session without SQL fails the load instead of the render.
    Promise.resolve()
      .then(() => ensureCardMdSeeded(tcw))
      .then(() => readCardMd(cardMdDatabase(tcw)))
      .then((stored) => {
        if (!current) return;
        // Seeding leaves a row; none means another device's write is in flight. Show the default it is writing.
        const shown = stored ?? { text: CARD_MD_DEFAULT, version: "", updatedAt: "" };
        setLoad({ state: "ready", stored: shown });
        setText(shown.text);
      })
      .catch((error: unknown) => { console.error("Loading card.md failed", error); if (current) setLoad({ state: "failed" }); });
    return () => { current = false; };
  }, [tcw]);
  useEffect(read, [read]);

  if (load.state === "loading") return <SectionCard icon={FileTextIcon} title={CARD_MD_STRINGS.title}><p className="text-xs text-muted-foreground">{CARD_MD_STRINGS.loading}</p></SectionCard>;
  if (load.state === "failed") {
    return (
      <SectionCard icon={FileTextIcon} title={CARD_MD_STRINGS.title}>
        <p className="text-xs text-muted-foreground">{CARD_MD_STRINGS.loadFailed}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => read()}>{CARD_MD_STRINGS.retry}</Button>
      </SectionCard>
    );
  }

  const { stored } = load;
  const changed = text !== stored.text;
  async function save() {
    setSaving(true); setSaveFailed(false);
    try {
      const saved = await saveCardMd(cardMdDatabase(tcw), text);
      setLoad({ state: "ready", stored: saved });
      setText(saved.text);
      // Agents a failed write missed get it the next time the Feed opens.
      void syncCardMd(tcw).catch((error: unknown) => console.error("Giving agents card.md failed", error));
    } catch (error) {
      console.error("Saving card.md failed", error);
      setSaveFailed(true);
    } finally { setSaving(false); }
  }

  return (
    <SectionCard icon={FileTextIcon} title={CARD_MD_STRINGS.title}>
      <p className="text-xs leading-relaxed text-muted-foreground">{CARD_MD_STRINGS.note}</p>
      <textarea
        aria-label={CARD_MD_STRINGS.label}
        value={text}
        onChange={(event) => { setText(event.target.value); setSaveFailed(false); }}
        rows={12}
        spellCheck={false}
        // 16 px on touch, so iOS doesn't zoom into it on focus.
        className="mt-3 w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-body leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:text-xs"
      />
      {text === "" && <p className="mt-1 text-xs text-muted-foreground">{CARD_MD_STRINGS.emptyNote}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? CARD_MD_STRINGS.saving : CARD_MD_STRINGS.save}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={saving || text === CARD_MD_DEFAULT} onClick={() => { setText(CARD_MD_DEFAULT); setSaveFailed(false); }}>
          {CARD_MD_STRINGS.reset}
        </Button>
        {changed && !saving && <span className="text-xs text-muted-foreground">{CARD_MD_STRINGS.unsaved}</span>}
      </div>
      {saveFailed && <p role="alert" className="mt-2 text-xs text-destructive">{CARD_MD_STRINGS.saveFailed}</p>}
      {stored.version && (
        <p data-testid="card-md-version" className="mt-2 text-xs tabular-nums text-muted-foreground">
          {CARD_MD_STRINGS.version.replace("{version}", stored.version).replace("{time}", new Date(stored.updatedAt).toLocaleString())}
        </p>
      )}
    </SectionCard>
  );
}
