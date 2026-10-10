// Each digit and the colon get a fixed-width slot, so the clock does not shift as the glyphs change (the app's font has no tabular figures).
export function TimerDigits({ text }: { text: string }) {
  return (
    <span className="pr-digits">
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
