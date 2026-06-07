import {
  ArrowLeftIcon,
  BrainIcon,
  CreditCardIcon,
  DatabaseIcon,
  LogOutIcon,
  SunIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import { MemoryPanel } from "@/components/MemoryPanel";
import { ThemeToggle } from "@/components/theme-toggle";
import { ImportDialog } from "./ImportDialog";
import { stateLabel, type AppState } from "../App";
import { formatCredits, type BillingStatus } from "../lib/billingApi";

interface SettingsPageProps {
  address: string | null;
  did: string | null;
  spaceId: string | null;
  state: AppState;
  error: string | null;
  onSignOut: () => void;
  paywallEnabled: boolean;
  onBack: () => void;
  tcw: TinyCloudWeb;
  memoryRef: React.MutableRefObject<string | null>;
  onMemoryUpdated: (doc: string | null) => void;
  onImported: () => void;
  billingStatus: BillingStatus | null;
  onManagePlan: () => void;
  onOpenRates: () => void;
}

export function SettingsPage({
  address,
  did,
  spaceId,
  state,
  error,
  onSignOut,
  paywallEnabled,
  onBack,
  tcw,
  memoryRef,
  onMemoryUpdated,
  onImported,
  billingStatus,
  onManagePlan,
  onOpenRates,
}: SettingsPageProps) {
  const usage = billingStatus?.usage;
  const hasLimit = !!usage && usage.limit > 0;
  const pct = hasLimit
    ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
    : 0;
  const near = pct >= 90;
  const resetsLabel = usage?.resetsAt ? formatResetsAt(usage.resetsAt) : null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            aria-label="Back to chat"
            onClick={onBack}
            className="h-8 gap-1.5 px-2 sm:px-3"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden sm:inline">Back to chat</span>
          </Button>
          <h1 className="text-base font-semibold tracking-tight">Settings</h1>
        </div>
        <div className="flex flex-col gap-4">
          <SectionCard icon={UserIcon} title="Account">
            <div className="flex items-center gap-2 text-xs">
              <span
                role="img"
                aria-label={stateLabel(state)}
                className={`size-1.5 rounded-full ${
                  state === "ready"
                    ? "bg-green-500"
                    : state === "recoverableError"
                      ? "bg-destructive"
                      : "bg-muted-foreground"
                }`}
              />
              <span className="text-muted-foreground">{stateLabel(state)}</span>
            </div>
            <div className="mt-3 flex flex-col gap-0.5 text-xs">
              <AccountRow label="Address" value={address ?? "none"} />
              <AccountRow label="DID" value={did ?? "none"} />
              <AccountRow label="Space" value={spaceId ?? "none"} />
            </div>
            {error && (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            )}
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={onSignOut}
                aria-label="Sign out"
                className="gap-1.5"
              >
                <LogOutIcon className="size-4" />
                <span>Sign out</span>
              </Button>
            </div>
          </SectionCard>
          <SectionCard icon={BrainIcon} title="Memory">
            <MemoryPanel
              variant="inline"
              tcw={tcw}
              memoryRef={memoryRef}
              onMemoryUpdated={onMemoryUpdated}
            />
          </SectionCard>
          <SectionCard icon={DatabaseIcon} title="Data">
            <p className="text-xs text-muted-foreground">
              Bring your Claude conversation history into this space.
            </p>
            <div className="mt-3">
              <ImportDialog tcw={tcw} onImported={onImported} />
            </div>
          </SectionCard>
          {paywallEnabled && (
            <SectionCard icon={CreditCardIcon} title="Plan & Usage">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">Current plan</span>
                <span className="text-sm font-medium">
                  {billingStatus ? capitalize(billingStatus.tier) : "—"}
                </span>
              </div>
              {hasLimit && (
                <div className="mt-3">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">Usage</span>
                    <span className="tabular-nums">
                      {usage.used.toLocaleString()} / {formatCredits(usage.limit)}
                    </span>
                  </div>
                  <span
                    className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    aria-hidden
                  >
                    <span
                      className={`block h-full rounded-full ${near ? "bg-destructive" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  {resetsLabel && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Resets {resetsLabel}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={onManagePlan}
                  aria-haspopup="dialog"
                >
                  Manage plan
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenRates}
                  aria-haspopup="dialog"
                >
                  How credits work
                </Button>
              </div>
            </SectionCard>
          )}
          <SectionCard icon={SunIcon} title="Appearance">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Theme</span>
              <ThemeToggle />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function AccountRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="max-w-[14rem] truncate text-right font-mono">
        {props.value}
      </span>
    </div>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatResetsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return d.toDateString();
  }
}

function SectionCard(props: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">{props.title}</h2>
      </div>
      {props.children && <div className="mt-3">{props.children}</div>}
    </section>
  );
}
