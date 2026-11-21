// Changing a bot from its panel (TC-3325): Edit (name, shape, colour) and Delete bot, which asks first. The calls are
// the roster client's (botRosterApi.ts); what the caller hands over as `BotManagement` re-reads the roster after each.
import { useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { useSizeClass } from "@/lib/sizeClass";
import { BotAvatar } from "./BotAvatar";
import { BotRosterError, isBotName, type CreateBotInput } from "./botRosterApi";
import { BOT_COLOUR_IDS, BOT_COLOURS, BOT_SHAPES, BotShape, type ColourId, type ShapeId } from "./botShapes";
import { BOT_MANAGE_STRINGS as copy, CREATE_BOT_STRINGS as create } from "./botsStrings";

/** What the panel may do to the bot on screen. */
export interface BotManagement {
  shape: ShapeId;
  colour: ColourId;
  /** The names of the owner's other bots: a name is unique among one owner's bots, ignoring case. */
  takenNames: readonly string[];
  update(input: Partial<CreateBotInput>): Promise<unknown>;
  /** Absent for Main, which cannot be deleted. */
  remove?(): Promise<unknown>;
}

export function EditBotDialog({ botKey, name: current, manage, onClose }: { botKey: string; name: string; manage: BotManagement; onClose: () => void }) {
  const formId = useId();
  const { size } = useSizeClass();
  const [name, setName] = useState(current);
  const [shape, setShape] = useState(manage.shape);
  const [colour, setColour] = useState(manage.colour);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const submitting = useRef(false);
  const trimmed = name.trim();
  const duplicate = manage.takenNames.some((taken) => taken.trim().toLowerCase() === trimmed.toLowerCase());
  const nameError = duplicate ? create.duplicate : name && !isBotName(name) ? create.invalidName : "";
  const changed = trimmed !== current || shape !== manage.shape || colour !== manage.colour;
  const disabled = !trimmed || Boolean(nameError) || !changed || saving;
  const error = serverError || nameError;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setServerError("");
    try {
      await manage.update({
        ...(trimmed !== current ? { name: trimmed } : {}),
        ...(shape !== manage.shape ? { shape } : {}),
        ...(colour !== manage.colour ? { colour } : {}),
      });
    } catch (cause) {
      setServerError(
        cause instanceof BotRosterError && cause.code === "name_taken" ? create.duplicate
          : cause instanceof BotRosterError && cause.code === "invalid_name" ? create.invalidName
            : copy.saveFailed,
      );
      return;
    } finally {
      submitting.current = false;
      setSaving(false);
    }
    onClose();
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      onOpenAutoFocus={(event) => { if (size === "compact") event.preventDefault(); }}
      dismissible={!saving}
      title={copy.edit}
      contentProps={{ "data-edit-bot-dialog": "" }}
      footer={<div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{create.cancel}</Button>
        <Button type="submit" form={formId} disabled={disabled}>{saving ? copy.saving : copy.save}</Button>
      </div>}
    >
      <ResponsiveSheetBody className="px-4 pb-5 pt-2">
        <form id={formId} onSubmit={submit} className="space-y-5">
          <div className="flex justify-center py-1">
            <BotAvatar bot={{ key: botKey, name: trimmed, shape, colour }} size={76} decorative />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-name`} className="text-sm font-medium">{create.name}</label>
            <input
              type="text"
              className="block w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
              id={`${formId}-name`}
              value={name}
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
              aria-describedby={error ? `${formId}-error` : undefined}
              disabled={saving}
              onChange={(event) => { setName(event.target.value); setServerError(""); }}
            />
            <div id={`${formId}-error`} role="status" className="text-sm text-muted-foreground empty:hidden">{error}</div>
          </div>
          <fieldset disabled={saving} className="min-w-0">
            <legend className="mb-2 text-sm font-medium">{create.shape}</legend>
            <div className="grid grid-cols-6 gap-1 min-[360px]:grid-cols-7">
              {BOT_SHAPES.map((id) => (
                <label key={id} className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-transparent text-foreground/80 hover:bg-accent has-[:checked]:border-foreground/60 has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  <input type="radio" name={`${formId}-shape`} className="sr-only" checked={shape === id} aria-label={create.shapes[id]} onChange={() => setShape(id)} />
                  <BotShape shape={id} size={32} />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={saving} className="min-w-0">
            <legend className="mb-2 text-sm font-medium">{create.colour}</legend>
            <div className="grid grid-cols-6 fine:grid-cols-11">
              {BOT_COLOUR_IDS.map((id) => (
                <label key={id} className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-transparent hover:bg-accent has-[:checked]:border-foreground/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  <input type="radio" name={`${formId}-colour`} className="sr-only" checked={colour === id} aria-label={create.colours[id]} onChange={() => setColour(id)} />
                  <span aria-hidden className="size-6 rounded-full border border-black/15" style={{ backgroundColor: `oklch(0.72 ${id === "slate" ? 0.045 : 0.13} ${BOT_COLOURS[id]})` }} />
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}

/** Asks before deleting. Cancel is the first choice; a failed delete keeps the question open with the reason. */
export function DeleteBotConfirm({ name, remove, onClose }: { name: string; remove: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await remove();
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  }
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent data-delete-bot-confirm="">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.deleteTitle(name)}</AlertDialogTitle>
          <AlertDialogDescription>{copy.deleteBody}</AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? <p role="alert" className="text-sm text-destructive">{copy.deleteFailed}</p> : null}
        <AlertDialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{create.cancel}</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>{busy ? copy.deleting : copy.deleteBot}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
