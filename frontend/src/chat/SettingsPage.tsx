import { AgentSetupCard } from "./AgentSetupCard";
import { useAgentAccess } from "./useAgentEnablement";
import { AgentAccessControls } from "./AgentEnablementBanner";
import {
  BookOpenIcon,
  BrainIcon,
  ChevronRightIcon,
  CreditCardIcon,
  DatabaseIcon,
  LogOutIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SectionCard } from "@/components/ui/section-card";
import { MemoryPanel } from "@/components/MemoryPanel";
import { AppearanceControl } from "./AppearanceControl";
import { ImportDialog } from "./ImportDialog";
import { stateLabel, type AppState } from "../lib/appState";
import { formatCredits, type BillingStatus } from "../lib/billingApi";
import { useBackendAttestation } from "../lib/useBackendAttestation";
import { BackendAttestationDetails } from "./BackendAttestationDetails";
import { useConversationCanvasFeature } from "./useExperimentalFeatures";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { useSizeClass } from "../lib/sizeClass";
import { PageHeader } from "../shell/PageHeader";
import { PATHS } from "../shell/routes";

/** An InfoTip beside a card title: a 44 px target on touch that doesn't push the title row taller. */
const TITLE_TIP = "-my-3 -ml-2 fine:-my-1 fine:-ml-1";

interface SettingsPageProps {
  address: string | null;
  did: string | null;
  spaceId: string | null;
  state: AppState;
  error: string | null;
  onSignOut: () => void;
  signingOut: boolean;
  paywallEnabled: boolean;
  onBack: () => void;
  tcw: TinyCloudWeb;
  memoryRef: React.MutableRefObject<string | null>;
  onMemoryUpdated: (doc: string | null) => void;
  onImported: () => void;
  billingStatus: BillingStatus | null;
  billingTierName: string | null;
  onManagePlan: () => void;
  onOpenRates: () => void;
  backendUrl: string;
  sessionStore: SessionStore;
}

export function SettingsPage({
  address,
  did,
  spaceId,
  state,
  error,
  onSignOut,
  signingOut,
  paywallEnabled,
  onBack,
  tcw,
  memoryRef,
  onMemoryUpdated,
  onImported,
  billingStatus,
  billingTierName,
  onManagePlan,
  onOpenRates,
  backendUrl,
  sessionStore,
}: SettingsPageProps) {
  const agentAccess = useAgentAccess();
  const conversationCanvas = useConversationCanvasFeature(tcw, billingStatus);
  const compact = useSizeClass().size === "compact";
  const usage = billingStatus?.usage;
  const hasLimit = !!usage && usage.limit > 0;
  const pct = hasLimit
    ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
    : 0;
  const near = pct >= 90;
  const resetsLabel = usage?.resetsAt ? formatResetsAt(usage.resetsAt) : null;
  return (
    // `relative`: the containing block for sr-only/absolute descendants, so they
    // scroll and clip with this pane instead of stretching the document (see
    // ConnectorsPage).
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      {/* Pushed over the app on a phone (Back, no tab bar); a pane beside the
          navigation on wider screens, so no Back there. */}
      <PageHeader title="Settings" back={compact ? onBack : undefined} className="mx-auto w-full max-w-2xl px-4 sm:px-6" />
      <div className="mx-auto w-full max-w-2xl px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
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
            <div className="mt-3 flex flex-col gap-2 text-xs">
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
                disabled={signingOut}
                aria-label="Sign out"
                className="gap-1.5"
              >
                <LogOutIcon className="size-4" />
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
              </Button>
            </div>
          </SectionCard>
          <SectionCard
            icon={ShieldCheckIcon}
            title="Agent access"
            aside={
              <InfoTip label="About agent access" className={TITLE_TIP}>
                Private agent memory and meeting access. Public web search stays available.
              </InfoTip>
            }
          >
            <AgentAccessControls {...agentAccess} />
          </SectionCard>
          <AgentSetupCard />
          <SectionCard icon={BrainIcon} title="Memory">
            <MemoryPanel
              variant="inline"
              tcw={tcw}
              memoryRef={memoryRef}
              onMemoryUpdated={onMemoryUpdated}
            />
          </SectionCard>
          <TranscriptionSettings tcw={tcw} />
          <SectionCard icon={ShieldCheckIcon} title="Infrastructure">
            <BackendAttestationPanel
              backendUrl={backendUrl}
              sessionStore={sessionStore}
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
                  {billingTierName ?? "—"}
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
            <AppearanceControl />
          </SectionCard>
          {conversationCanvas.eligible && (
            <SectionCard icon={DatabaseIcon} title="Experimental Features">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center">
                  <p className="text-sm font-medium">Conversation Canvas</p>
                  <InfoTip label="About Conversation Canvas" className="-my-3 fine:-my-1">
                    Explore branches and pin immutable Markdown context in a visual chat.
                  </InfoTip>
                </div>
                {/* A 44 px target on touch around the 44x24 track. */}
                <button type="button" role="switch" aria-checked={conversationCanvas.enabled} aria-label="Enable Conversation Canvas" disabled={conversationCanvas.loading} onClick={() => void conversationCanvas.setEnabled(!conversationCanvas.enabled)} className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 fine:my-0 fine:h-6 fine:w-11">
                  <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${conversationCanvas.enabled ? "bg-primary" : "bg-muted"}`}>
                    <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${conversationCanvas.enabled ? "left-6" : "left-1"}`} />
                  </span>
                </button>
              </div>
              {conversationCanvas.error && <p role="alert" className="mt-2 text-xs text-destructive">{conversationCanvas.error}</p>}
            </SectionCard>
          )}
          <Link
            to={PATHS.about}
            className="tap-transparent flex min-h-14 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold tracking-tight transition-colors hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-12"
          >
            <BookOpenIcon aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex-1">How it works</span>
            <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function BackendAttestationPanel(props: {
  backendUrl: string;
  sessionStore: SessionStore;
}) {
  // serverInfoDid is intentionally NOT passed: the hook fetches the backend's
  // published DID from /api/server-info itself, so the binding leg cross-checks
  // the attested signing key — never the caller's own session DID.
  const { status, verdict, attestation, message, reverify } =
    useBackendAttestation({
      backendUrl: props.backendUrl,
      sessionStore: props.sessionStore,
    });

  const busy = status === "idle" || status === "verifying";
  // Honest status pill: green/teal "Backend attested" ONLY when all three legs
  // pass; amber "Quote issued" once a quote was fetched but verification is
  // incomplete; destructive for auth/error; grey otherwise.
  const label =
    status === "attested"
      ? "Backend attested"
      : status === "unattested"
        ? "Quote issued — verification incomplete"
        : status === "unavailable"
          ? "Not attestable here"
          : status === "unauthenticated"
            ? "Sign in required"
            : status === "error"
              ? "Check failed"
              : "Checking";
  const tone =
    status === "attested"
      ? "bg-emerald-500"
      : status === "unattested"
        ? "bg-amber-500"
        : status === "error" || status === "unauthenticated"
          ? "bg-destructive"
          : "bg-muted-foreground";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span role="img" aria-label={label} className={`size-1.5 rounded-full ${tone}`} />
          <span className="text-muted-foreground">{label}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={reverify}
          disabled={busy}
          aria-label="Recheck backend attestation"
          className="gap-1.5 px-2"
        >
          <RefreshCwIcon className={`size-4 ${busy ? "animate-spin" : ""}`} />
          <span>{busy ? "Checking" : "Recheck"}</span>
        </Button>
      </div>
      {verdict ? (
        <BackendAttestationDetails verdict={verdict} attestation={attestation} />
      ) : message ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Waiting for the backend quote check.
        </p>
      )}
      {/* What the three legs check, and why it reads Quote issued today: How it works → verification. */}
      <HowItWorksLink section="verification">What verification checks</HowItWorksLink>
    </div>
  );
}

// The whole value, wrapped: an address or DID cut off with an ellipsis can't be checked or copied.
function AccountRow(props: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="select-text break-all font-mono">{props.value}</span>
    </div>
  );
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
