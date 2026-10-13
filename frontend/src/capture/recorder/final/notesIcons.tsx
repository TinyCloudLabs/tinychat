import type { ReactNode } from "react";

function Icon({
  size,
  children,
  strokeWidth = 1.8,
}: {
  size: number;
  children: ReactNode;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const NotesListIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="M10 7h10M10 12h10M10 17h10" />
    <circle cx="5" cy="7" r="1.2" />
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="5" cy="17" r="1.2" />
  </Icon>
);

export const EnterIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2.2}>
    <path d="M19 6v6a2 2 0 0 1-2 2H6M10 9l-4 5 4 5" />
  </Icon>
);

export const BulletsIcon = () => (
  <Icon size={18} strokeWidth={1.7}>
    <path d="M10 7h10M10 12h10M10 17h10" />
    <circle cx="5" cy="7" r="1.2" />
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="5" cy="17" r="1.2" />
  </Icon>
);

export const ChecklistIcon = () => (
  <Icon size={18} strokeWidth={1.7}>
    <rect x="3.5" y="4.5" width="6" height="6" rx="1.6" />
    <path d="M5 7.6l1 1 2-2.2M13 7.5h8M13 16.5h8" />
    <rect x="3.5" y="13.5" width="6" height="6" rx="1.6" />
  </Icon>
);

export const QuoteIcon = () => (
  <Icon size={18} strokeWidth={1.7}>
    <path d="M9.5 8H6.5a1.5 1.5 0 0 0-1.5 1.5V12a1.5 1.5 0 0 0 1.5 1.5H9V15a3 3 0 0 1-3 3M19 8h-3a1.5 1.5 0 0 0-1.5 1.5V12a1.5 1.5 0 0 0 1.5 1.5h2.5V15a3 3 0 0 1-3 3" />
  </Icon>
);
