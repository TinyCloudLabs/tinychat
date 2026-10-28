import type { ReactNode } from "react";

function Glyph({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PauseGlyph = ({ size }: { size: number }) => (
  <Glyph size={size}>
    <path d="M9 6v12M15 6v12" />
  </Glyph>
);
export const PlayGlyph = ({ size }: { size: number }) => (
  <Glyph size={size}>
    <path d="M8 5.5l11 6.5-11 6.5z" />
  </Glyph>
);
