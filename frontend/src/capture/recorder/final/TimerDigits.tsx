// Each digit and the colon get a fixed-width slot, so the clock does not shift as the glyphs change (the app's font has no tabular figures).
// The slots are atomic boxes, so they are isolated as LTR (an RTL ancestor would reverse them) and hidden from assistive tech: the timer carries the whole time as its aria-label.
export function TimerDigits({ text }: { text: string }) {
  return (
    <span className="pr-digits" dir="ltr" aria-hidden="true">
      {[...text].map((char, index) => (
        <span
          key={index}
          className={char === ":" ? "pr-colon" : "pr-digit"}
        >
          {char}
        </span>
      ))}
    </span>
  );
}
