// Settings → Word fixes: the user's find-and-replace list for transcripts (TC-2199). Add, edit and delete a pair
// inline; Enter saves, Escape cancels.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ArrowRightIcon, PencilIcon, SpellCheckIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { MAX_WORD_FIX_LENGTH, MAX_WORD_FIXES, withoutWordFix, withWordFix, type WordFix } from "@/lib/wordFixes/wordFixes";
import { WORD_FIXES_COPY as COPY } from "@/lib/wordFixes/wordFixesCopy";
import { saveWordFixes, useWordFixes } from "@/lib/wordFixes/wordFixesStore";

const FIELD = "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base sm:flex-1 fine:h-9 fine:text-callout focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const ICON_BUTTON = "size-11 shrink-0 text-muted-foreground fine:size-9";

function EditRow(props: { initial: WordFix; onSave: (fix: WordFix) => void; onCancel: () => void }) {
  // Uncontrolled fields: the values are read when saving, and only "is the find empty" is state.
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [canSave, setCanSave] = useState(props.initial.find.trim() !== "");
  useEffect(() => { findRef.current?.focus(); }, []);
  const save = () => {
    const find = findRef.current?.value ?? "";
    if (find.trim() !== "") props.onSave({ find, replace: replaceRef.current?.value ?? "" });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
    else if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
  };
  const fieldProps = { className: FIELD, maxLength: MAX_WORD_FIX_LENGTH, autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-background p-2" data-testid="word-fix-edit" onKeyDown={onKeyDown}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input ref={findRef} {...fieldProps} defaultValue={props.initial.find} aria-label={COPY.findLabel} placeholder={COPY.findPlaceholder}
          onInput={(event) => setCanSave(event.currentTarget.value.trim() !== "")} />
        <input ref={replaceRef} {...fieldProps} defaultValue={props.initial.replace} aria-label={COPY.replaceLabel} placeholder={COPY.replacePlaceholder} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onCancel}>{COPY.cancel}</Button>
        <Button type="button" disabled={!canSave} onClick={save}>{COPY.save}</Button>
      </div>
    </li>
  );
}

const NEW_FIX: WordFix = { find: "", replace: "" };

export function WordFixesSettings({ tcw }: { tcw: TinyCloudWeb }) {
  const fixes = useWordFixes();
  // The `find` of the entry being edited, "" for a new one, null when nothing is being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const commit = (next: typeof fixes) => {
    setFailed(false);
    saveWordFixes(tcw, next).catch(() => setFailed(true));
  };
  const save = (fix: WordFix) => {
    const previous = editing === "" ? undefined : editing ?? undefined;
    commit(withWordFix(fixes, fix, previous));
    setEditing(null);
  };

  return (
    <SectionCard icon={SpellCheckIcon} title={COPY.title}>
      <div className="flex flex-col gap-3" data-testid="word-fixes">
        <p className="text-callout text-muted-foreground">{COPY.hint}</p>
        {fixes.length === 0 && editing === null && <p className="text-callout text-muted-foreground" data-testid="word-fixes-empty">{COPY.empty}</p>}
        <ul className="flex flex-col gap-1">
          {fixes.map((fix) => editing === fix.find
            ? <EditRow key={fix.find} initial={fix} onSave={save} onCancel={() => setEditing(null)} />
            : (
              <li key={fix.find} className="flex items-center gap-1" data-testid="word-fix">
                <button type="button" aria-label={COPY.edit(fix.find)} onClick={() => setEditing(fix.find)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-callout hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0 break-words font-medium">{fix.find}</span>
                  <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="sr-only">{COPY.replacesWith}</span>
                  <span className="min-w-0 break-words">{fix.replace === "" ? <span className="text-muted-foreground">{COPY.nothing}</span> : fix.replace}</span>
                  <PencilIcon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
                <Button type="button" variant="ghost" size="icon" className={ICON_BUTTON} aria-label={COPY.remove(fix.find)} onClick={() => commit(withoutWordFix(fixes, fix.find))}>
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          {editing === "" && <EditRow initial={NEW_FIX} onSave={save} onCancel={() => setEditing(null)} />}
        </ul>
        {failed && <p role="alert" className="text-callout text-destructive">{COPY.failed}</p>}
        {editing === null && fixes.length < MAX_WORD_FIXES && (
          <div><Button type="button" variant="outline" onClick={() => setEditing("")}>{COPY.add}</Button></div>
        )}
      </div>
    </SectionCard>
  );
}
