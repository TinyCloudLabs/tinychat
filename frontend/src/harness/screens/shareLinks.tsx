// "Your shared links" (TC-1800), populated and empty: the real Settings page with
// its card, and the Share dialog's list under its heading. The links sit on a
// stand-in space whose KV holds their owner records, so the real list code loads
// them; the titles and expiry times cover a long title, "today at", "tomorrow at"
// and a later date. At 2x text the rows must still read in full.
import type { ReactNode } from "react";

import { SettingsPage } from "@/chat/SettingsPage";
import { OwnedShareLinksSection } from "@/chat/OwnedShareLinks";
import { AgentAccessProvider } from "@/chat/useAgentEnablement";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHARE_LINK_COPY } from "@/lib/shareLinkCopy";
import { shareIndexKeyFor, snapshotKeyFor } from "@/lib/shareRecords";
import type { OwnedTinychatShare } from "@/lib/tinychatShareLinks";
import { FROZEN_NOW, HARNESS_ADDRESS, HARNESS_DID, harnessSessionStore, harnessTcw } from "../stubs";
import type { HarnessScreen } from "../screen";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const HOUR = 60 * 60 * 1000;

const LINKS = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Planning the quarterly roadmap review with the whole design team", expiresIn: 5 * HOUR },
  { id: "22222222-2222-4222-8222-222222222222", title: "Trip notes", expiresIn: 20 * HOUR },
  { id: "33333333-3333-4333-8333-333333333333", title: "Q3 retro", expiresIn: 9 * 24 * HOUR },
];

const iso = (offset: number) => new Date(FROZEN_NOW + offset).toISOString();

const missing = { ok: false, error: { code: "KV_NOT_FOUND", message: "harness: nothing stored" } };

/** The empty-space stub, with the owner's share records in KV (none when `links` is empty). */
function spaceWithLinks(links: typeof LINKS): TinyCloudWeb {
  const records = new Map<string, string>();
  for (const link of links) {
    records.set(
      shareIndexKeyFor(link.id),
      JSON.stringify({
        shareId: link.id,
        threadId: `thread-${link.id.slice(0, 1)}`,
        title: link.title,
        key: snapshotKeyFor(link.id),
        cid: `cid-${link.id.slice(0, 1)}`,
        createdAt: iso(-HOUR),
        expiresAt: iso(link.expiresIn),
      }),
    );
  }
  const kv = new Proxy(harnessTcw.kv, {
    get: (target, key) => {
      if (key === "list") {
        return async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...records.keys()].filter((k) => k.startsWith(path)) } });
      }
      if (key === "get") return async (k: string) => (records.has(k) ? { ok: true, data: { data: records.get(k) } } : missing);
      return Reflect.get(target, key);
    },
  });
  return new Proxy(harnessTcw, { get: (target, key) => (key === "kv" ? kv : Reflect.get(target, key)) });
}

function Settings(props: { links: typeof LINKS }) {
  const tcw = spaceWithLinks(props.links);
  return (
    <AgentAccessProvider tcw={tcw} sessionStore={harnessSessionStore} backendUrl={window.location.origin} appName="harness" openkeyHost={window.location.origin}>
      <div className="bg-background text-foreground" style={{ height: "var(--tc-app-height, 100dvh)" }}>
        <StaticRecorderProvider>
          <SettingsPage
            address={HARNESS_ADDRESS}
            did={HARNESS_DID}
            spaceId="harness-space"
            state="ready"
            error={null}
            onSignOut={() => {}}
            signingOut={false}
            paywallEnabled={false}
            onBack={() => {}}
            tcw={tcw}
            memoryRef={{ current: null }}
            onMemoryUpdated={() => {}}
            onImported={() => {}}
            billingStatus={null}
            billingTierName={null}
            onManagePlan={() => {}}
            onOpenRates={() => {}}
            backendUrl={window.location.origin}
            sessionStore={harnessSessionStore}
          />
        </StaticRecorderProvider>
      </div>
    </AgentAccessProvider>
  );
}

/** The Share dialog of a chat with no link while creation is paused: the notice and the list. */
function ShareDialog(): ReactNode {
  const shares: OwnedTinychatShare[] = LINKS.map((link) => ({
    shareId: link.id,
    threadId: "thread",
    title: link.title,
    createdAt: iso(-HOUR),
    expiresAt: iso(link.expiresIn),
  }));
  return (
    <div className="bg-background text-foreground" style={{ height: "var(--tc-app-height, 100dvh)" }}>
      <Dialog open>
        {/* The built-in X (a 24 px target on every dialog) is not what this screen checks; the footer has Close. */}
        <DialogContent hideCloseButton>
          <DialogHeader>
            <DialogTitle>Share chat</DialogTitle>
            <DialogDescription>{SHARE_LINK_COPY.creationPaused}</DialogDescription>
          </DialogHeader>
          <OwnedShareLinksSection shares={shares} />
          <DialogFooter>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CARD = "section:has(> div > svg.lucide-link)";

export const shareLinksScreens: HarnessScreen[] = [
  {
    id: "share-links-settings-populated",
    group: "share-links",
    layout: "pane",
    displayTitle: true,
    path: "/chat/settings",
    readyWhen: '[data-testid="owned-share-link"]',
    scrollTo: CARD,
    render: () => <Settings links={LINKS} />,
  },
  {
    id: "share-links-settings-empty",
    group: "share-links",
    layout: "pane",
    displayTitle: true,
    path: "/chat/settings",
    readyWhen: '[data-testid="owned-share-links-empty"]',
    scrollTo: CARD,
    render: () => <Settings links={[]} />,
  },
  {
    id: "share-links-dialog-populated",
    group: "share-links",
    layout: "pane",
    readyWhen: '[data-testid="owned-share-link"]',
    render: () => <ShareDialog />,
  },
];
