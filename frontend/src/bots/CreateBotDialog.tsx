import { useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { useSizeClass } from "@/lib/sizeClass";
import { BotAvatar } from "./BotAvatar";
import { BOT_COLOUR_IDS, BOT_SHAPES, BOT_COLOURS, BotShape, type ColourId, type ShapeId } from "./botShapes";
import { BotRosterError, isBotName, type BotRoster, type CreateBotInput, type RosterBot } from "./botRosterApi";
import { CREATE_BOT_STRINGS as copy } from "./botsStrings";
import { BotHistoryApprovalNeeded } from "./historyGrant";

interface CreateBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: BotRoster;
  onCreate: (input: CreateBotInput) => Promise<RosterBot>;
  onCreated?: (bot: RosterBot) => void;
}

export function CreateBotDialog({ open, ...props }: CreateBotDialogProps) {
  return open ? <CreateBotForm {...props} /> : null;
}

function CreateBotForm({ onOpenChange, roster, onCreate, onCreated }: Omit<CreateBotDialogProps, "open">) {
  const formId = useId();
  const { size } = useSizeClass();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<ShapeId>("pebble");
  const [colour, setColour] = useState<ColourId>("blue");
  const [creating, setCreating] = useState(false);
  const [serverError, setServerError] = useState("");
  const submitting = useRef(false);
  const trimmed = name.trim();
  const capped = !roster.canCreate.private && !roster.canCreate.regular;
  const max = roster.limits?.private.max;
  const capCopy = copy.cap[roster.capMode];
  const hasOtherBot = roster.bots.some(bot => bot.key !== "main");
  const duplicate = roster.bots.some(bot => bot.name.trim().toLowerCase() === trimmed.toLowerCase());
  const nameError = duplicate ? copy.duplicate : name && !isBotName(name) ? copy.invalidName : "";
  const disabled = capped || !trimmed || Boolean(nameError) || creating;
  const error = serverError || (capped && max !== undefined ? capCopy.atLimit(max, hasOtherBot) : nameError);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    submitting.current = true;
    setCreating(true);
    setServerError("");
    let bot: RosterBot;
    try {
      bot = await onCreate({ name: trimmed, shape, colour });
    } catch (cause) {
      // Keep the draft open and restore the form controls in finally.
      if (cause instanceof BotHistoryApprovalNeeded) return;
      if (cause instanceof BotRosterError && cause.code === "bot_limit" && max !== undefined) setServerError(capCopy.refused(max, hasOtherBot));
      else if (cause instanceof BotRosterError && cause.code === "name_taken") setServerError(copy.duplicate);
      else if (cause instanceof BotRosterError && cause.code === "invalid_name") setServerError(copy.invalidName);
      else setServerError(copy.failed);
      return;
    } finally {
      submitting.current = false;
      setCreating(false);
    }
    onOpenChange(false);
    onCreated?.(bot);
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={onOpenChange}
      onOpenAutoFocus={event => { if (size === "compact") event.preventDefault(); }}
      dismissible={!creating}
      title={copy.title}
      contentProps={{ "data-create-bot-dialog": "" }}
      footer={<div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={creating} onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
        <Button type="submit" form={formId} disabled={disabled}>{creating ? copy.creating : copy.create}</Button>
      </div>}
    >
      <ResponsiveSheetBody className="px-4 pb-5 pt-2">
        <form id={formId} onSubmit={submit} className="space-y-5">
          <div className="flex justify-center py-1">
            <BotAvatar bot={{ name: trimmed, shape, colour }} size={76} decorative />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-name`} className="text-sm font-medium">{copy.name}</label>
            <input
              type="text"
              className="block w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
              id={`${formId}-name`}
              value={name}
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
              aria-describedby={error ? `${formId}-error` : undefined}
              disabled={creating}
              onChange={event => { setName(event.target.value); setServerError(""); }}
            />
            <div id={`${formId}-error`} role="status" className="text-sm text-muted-foreground empty:hidden">{error}</div>
          </div>
          <fieldset disabled={creating} className="min-w-0">
            <legend className="mb-2 text-sm font-medium">{copy.shape}</legend>
            <div className="grid grid-cols-6 min-[360px]:grid-cols-7 gap-1">
              {BOT_SHAPES.map(id => (
                <label key={id} className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-transparent text-foreground/80 hover:bg-accent has-[:checked]:border-foreground/60 has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  <input type="radio" name={`${formId}-shape`} className="sr-only" checked={shape === id} aria-label={copy.shapes[id]} onChange={() => setShape(id)} />
                  <BotShape shape={id} size={32} />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={creating} className="min-w-0">
            <legend className="mb-2 text-sm font-medium">{copy.colour}</legend>
            <div className="grid grid-cols-6 fine:grid-cols-11">
              {BOT_COLOUR_IDS.map(id => (
                <label key={id} className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-transparent hover:bg-accent has-[:checked]:border-foreground/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  <input type="radio" name={`${formId}-colour`} className="sr-only" checked={colour === id} aria-label={copy.colours[id]} onChange={() => setColour(id)} />
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
