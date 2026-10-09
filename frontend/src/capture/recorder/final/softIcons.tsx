import type { ReactNode } from "react";
import type { ModeId } from "./transcriptionModes";

function Icon({
  size,
  children,
  className,
}: {
  size: number;
  children: ReactNode;
  className?: string;
}) {
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
      className={className}
    >
      {children}
    </svg>
  );
}

export function ModeIcon({ id, size = 14 }: { id: ModeId; size?: number }) {
  switch (id) {
    case "skip":
      return (
        <Icon size={size}>
          <circle cx="12" cy="12" r="8" />
          <path d="M6.5 17.5l11-11" />
        </Icon>
      );
    case "local":
      return (
        <Icon size={size}>
          <rect x="7" y="3" width="10" height="18" rx="2.5" />
          <path d="M11 18h2" />
        </Icon>
      );
    case "private":
      return (
        <Icon size={size}>
          <rect x="5" y="11" width="14" height="9" rx="2.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </Icon>
      );
    case "powerful":
      return (
        <Icon size={size}>
          <path d="M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z" />
          <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
        </Icon>
      );
  }
}

export const ChevronDownIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M7 10l5 5 5-5" />
  </Icon>
);
export const CloseIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const PauseIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9 6v12M15 6v12" />
  </Icon>
);
export const PlayIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M8 5.5l11 6.5-11 6.5z" />
  </Icon>
);
export const CheckIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const MicIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Icon>
);
export const HeadphonesIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="3.5" y="13.5" width="4" height="7" rx="2" />
    <rect x="16.5" y="13.5" width="4" height="7" rx="2" />
  </Icon>
);

/** ⓘ⌄: the modes card opener. */
export function InfoChevronIcon() {
  return (
    <svg
      width="21"
      height="16"
      viewBox="0 0 32 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10.5" cy="12" r="8.2" />
      <path d="M10.5 11v5.2M10.5 7.7v.1" />
      <path d="M22.5 10.5l3.25 3.25L29 10.5" />
    </svg>
  );
}

/** The ring's centre glyph: pause while it records (faint), play when a tap would resume. */
export function RingGlyph({ kind }: { kind: "pause" | "play" }) {
  return (
    <svg
      className="pr-mid"
      data-glyph={kind}
      width="32"
      height="32"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "pause" ? (
        <g opacity=".28">
          <rect x="15" y="12" width="6.5" height="24" rx="3.2" />
          <rect x="26.5" y="12" width="6.5" height="24" rx="3.2" />
        </g>
      ) : (
        <path
          opacity=".9"
          d="M18 13.8v20.4a2.6 2.6 0 0 0 4 2.2l15.6-10.2a2.6 2.6 0 0 0 0-4.4L22 11.6a2.6 2.6 0 0 0-4 2.2z"
        />
      )}
    </svg>
  );
}
