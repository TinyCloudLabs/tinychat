// TC-3892: Settings -> Where your data lives.
// Shows the owner's verified location-registry v2 record, lets them change node hosts via
// OpenKey.requestRegistryChange (when available), lists recent changes, and offers Undo for
// the latest change.
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon, ServerIcon, Undo2Icon } from "lucide-react";
import type { LocationRecordV2 } from "@tinycloud/sdk-core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { spaceDisplayName } from "@/lib/registryConsent/preview";
import {
  canonicalizeRegistryChangeRequest,
  countRecordChanges,
  createRegistryEditorAdapter,
  displayCanonicalHost,
  formatRegistryDate,
  requestFromLocationRecord,
  type RegistryChangeClientLike,
  type RegistryChangeHistoryEntry,
  type RegistryEditorAdapter,
} from "@/lib/registryEditor/adapter";
import { REGISTRY_EDITOR_COPY } from "@/lib/registryEditor/copy";

export interface RegistrySectionProps {
  did: string | null;
  openkey?: RegistryChangeClientLike | null;
  openkeyHost?: string;
  /** Injectable adapter for tests. */
  adapter?: RegistryEditorAdapter;
}

type RecordState =
  | { phase: "loading" }
  | { phase: "found"; record: LocationRecordV2 }
  | { phase: "missing" }
  | { phase: "error" };

type HistoryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; entries: RegistryChangeHistoryEntry[] }
  | { phase: "error" };

interface EditDraft {
  /** Editable host URLs indexed by space URI (first member URL per space). */
  spaceUrls: Record<string, string>;
  /** Fallback node URLs when a record has nodes but no spaces. */
  nodeUrls: string[];
  /** Editable encryption node URL, or "" for Not set (`null`). */
  encryptionUrl: string;
}

function buildEditDraft(record: LocationRecordV2): EditDraft {
  const urlByDid = new Map(record.nodes.map((node) => [node.did, node.url]));
  const spaceUrls: Record<string, string> = {};
  for (const space of record.spaces) {
    const primaryDid = space.nodes[0]?.did;
    spaceUrls[space.space] = primaryDid ? (urlByDid.get(primaryDid) ?? "") : "";
  }
  const encryptionUrl = record.encryptionNode ? (urlByDid.get(record.encryptionNode) ?? "") : "";
  return {
    spaceUrls,
    nodeUrls: record.nodes.map((node) => node.url),
    encryptionUrl,
  };
}

export function RegistrySection(props: RegistrySectionProps) {
  const { did, openkey, openkeyHost, adapter: injectedAdapter } = props;
  const adapter = useMemo(
    () => injectedAdapter ?? createRegistryEditorAdapter({ openkey, openkeyHost }),
    [injectedAdapter, openkey, openkeyHost],
  );

  const [recordState, setRecordState] = useState<RecordState>({ phase: "loading" });
  const [historyState, setHistoryState] = useState<HistoryState>({ phase: "idle" });
  const [reloadTick, setReloadTick] = useState(0);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);

  const reload = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!did) {
      setRecordState({ phase: "missing" });
      setHistoryState({ phase: "idle" });
      return;
    }

    const controller = new AbortController();
    setRecordState({ phase: "loading" });

    void (async () => {
      try {
        const result = await adapter.readCurrentRecord(did, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === "found") {
          setRecordState({ phase: "found", record: result.record });
        } else if (result.status === "missing") {
          setRecordState({ phase: "missing" });
        } else {
          setRecordState({ phase: "error" });
        }
      } catch {
        if (!controller.signal.aborted) {
          setRecordState({ phase: "error" });
        }
      }
    })();

    if (adapter.canEdit) {
      setHistoryState({ phase: "loading" });
      void (async () => {
        try {
          const result = await adapter.fetchHistory(controller.signal);
          if (controller.signal.aborted) return;
          if (result.status === "ok") {
            setHistoryState({ phase: "loaded", entries: result.history });
          } else {
            setHistoryState({ phase: "error" });
          }
        } catch {
          if (!controller.signal.aborted) {
            setHistoryState({ phase: "error" });
          }
        }
      })();
    } else {
      setHistoryState({ phase: "idle" });
    }

    return () => controller.abort();
  }, [adapter, did, reloadTick]);

  const record = recordState.phase === "found" ? recordState.record : null;
  const nodeUrlByDid = useMemo(
    () => new Map((record?.nodes ?? []).map((n) => [n.did, n.url])),
    [record],
  );
  const historyEntries = historyState.phase === "loaded" ? historyState.entries : [];
  const latestHistory = historyEntries[0] ?? null;

  const openEditor = () => {
    if (!record) return;
    setDraft(buildEditDraft(record));
    setEditError(null);
    setStatusNotice(null);
    setEditing(true);
  };

  const cancelEditor = () => {
    setEditing(false);
    setDraft(null);
    setEditError(null);
  };

  const submitChange = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!record || !draft || submitting) return;
    setEditError(null);
    setStatusNotice(null);

    let canonicalRequest;
    try {
      const rawSpaces =
        record.spaces.length > 0
          ? record.spaces.map((space) => {
              const primaryUrl = draft.spaceUrls[space.space] ?? "";
              const additionalNodes = space.nodes
                .slice(1)
                .map((member) => {
                  const url = nodeUrlByDid.get(member.did);
                  return url ? { url, mode: member.mode } : null;
                })
                .filter((item): item is { url: string; mode: "read-write" | "read-only" } => item !== null);
              const primaryMode = space.nodes[0]?.mode ?? "read-write";
              return {
                space: space.space,
                nodes: [{ url: primaryUrl, mode: primaryMode }, ...additionalNodes],
              };
            })
          : undefined;

      const rawNodes =
        record.spaces.length > 0
          ? rawSpaces!.flatMap((s) => s.nodes.map((n) => ({ url: n.url })))
          : draft.nodeUrls.map((url) => ({ url }));

      canonicalRequest = canonicalizeRegistryChangeRequest(
        {
          nodes: rawNodes,
          ...(rawSpaces ? { spaces: rawSpaces } : {}),
          encryptionNode: draft.encryptionUrl.trim() === "" ? null : draft.encryptionUrl,
        },
        record.nodes,
      );
    } catch {
      setEditError(REGISTRY_EDITOR_COPY.invalidNodeUrl);
      return;
    }

    setSubmitting(true);
    try {
      const outcome = await adapter.requestChange(canonicalRequest);
      if (outcome.status === "published") {
        setEditing(false);
        setDraft(null);
        setStatusNotice({ tone: "ok", text: REGISTRY_EDITOR_COPY.changeSuccess });
        reload();
      }
    } catch {
      setEditError(REGISTRY_EDITOR_COPY.changeFailure);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmUndo = async () => {
    if (!latestHistory || submitting) return;
    setStatusNotice(null);
    setSubmitting(true);
    try {
      const request = requestFromLocationRecord(latestHistory.previousRecord);
      const outcome = await adapter.requestChange(request);
      setUndoConfirmOpen(false);
      if (outcome.status === "published") {
        setStatusNotice({ tone: "ok", text: REGISTRY_EDITOR_COPY.undoSuccess });
        reload();
      }
    } catch {
      setUndoConfirmOpen(false);
      setStatusNotice({ tone: "error", text: REGISTRY_EDITOR_COPY.changeFailure });
    } finally {
      setSubmitting(false);
    }
  };

  const encryptionHost = record?.encryptionNode
    ? displayCanonicalHost(nodeUrlByDid.get(record.encryptionNode) ?? record.encryptionNode)
    : null;

  return (
    <SectionCard id="registry" icon={ServerIcon} title={REGISTRY_EDITOR_COPY.heading}>
      <p className="text-xs text-muted-foreground">{REGISTRY_EDITOR_COPY.intro}</p>

      {statusNotice && (
        <p
          role={statusNotice.tone === "error" ? "alert" : "status"}
          className={`mt-3 text-xs ${statusNotice.tone === "error" ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
        >
          {statusNotice.text}
        </p>
      )}

      {recordState.phase === "loading" && (
        <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
      )}

      {recordState.phase === "error" && (
        <div className="mt-3 space-y-2" data-testid="registry-error">
          <p role="alert" className="text-xs text-destructive">
            {REGISTRY_EDITOR_COPY.registryUnreachable}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reload} className="gap-1.5">
            <RefreshCwIcon className="size-3.5" />
            <span>{REGISTRY_EDITOR_COPY.retryButton}</span>
          </Button>
        </div>
      )}

      {recordState.phase === "missing" && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="registry-missing">
          {REGISTRY_EDITOR_COPY.noRecord}
        </p>
      )}

      {record && (
        <div className="mt-3 space-y-3" data-testid="registry-record">
          {/* Spaces -> Hosts table */}
          <div className="overflow-hidden rounded-md border border-border text-xs">
            <div className="grid grid-cols-2 border-b border-border bg-muted/50 px-3 py-1.5 font-medium text-muted-foreground">
              <span>{REGISTRY_EDITOR_COPY.labels.space}</span>
              <span>{REGISTRY_EDITOR_COPY.labels.host}</span>
            </div>
            {record.spaces.map((space) => {
              const label = spaceDisplayName(space.space).name;
              const hosts = space.nodes
                .map((member) => {
                  const raw = nodeUrlByDid.get(member.did) ?? member.did;
                  const host = displayCanonicalHost(raw);
                  return member.mode === "read-only" ? `${host} (read-only)` : host;
                })
                .join(", ");
              return (
                <div
                  key={space.space}
                  data-testid="registry-space-row"
                  className="grid grid-cols-2 gap-2 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="truncate font-medium" title={space.space}>
                    {label}
                  </span>
                  <span className="break-all font-mono">{hosts || REGISTRY_EDITOR_COPY.notSet}</span>
                </div>
              );
            })}
            {/* Encryption node on its own distinct row */}
            <div
              data-testid="registry-encryption-row"
              className="grid grid-cols-2 gap-2 border-t border-border bg-amber-500/10 px-3 py-2"
            >
              <span className="font-medium text-amber-800 dark:text-amber-300">
                {REGISTRY_EDITOR_COPY.encryptionLabel}
              </span>
              <span className="break-all font-mono text-amber-900 dark:text-amber-200">
                {encryptionHost ?? REGISTRY_EDITOR_COPY.notSet}
              </span>
            </div>
          </div>

          {/* Nodes & sequence metadata */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span data-testid="registry-nodes">
              Nodes: {record.nodes.map((node) => displayCanonicalHost(node.url)).join(", ") || REGISTRY_EDITOR_COPY.notSet}
            </span>
            <span data-testid="registry-sequence" className="tabular-nums">
              Sequence {record.sequence}
            </span>
          </div>

          {latestHistory && (
            <p className="text-[11px] text-muted-foreground" data-testid="registry-last-changed">
              {REGISTRY_EDITOR_COPY.updatedLabel(
                formatRegistryDate(latestHistory.createdAt),
                latestHistory.requestingOrigin,
              )}
            </p>
          )}

          {/* Change button & inline editor (only when OpenKey.requestRegistryChange is present) */}
          {adapter.canEdit && !editing && (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={openEditor} disabled={submitting}>
                {REGISTRY_EDITOR_COPY.changeButton}
              </Button>
            </div>
          )}

          {adapter.canEdit && editing && draft && (
            <form noValidate onSubmit={(e) => void submitChange(e)} className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="registry-editor-form">
              {record.spaces.length > 0 ? (
                record.spaces.map((space) => {
                  const inputId = `registry-space-${space.space}`;
                  const label = spaceDisplayName(space.space).name;
                  return (
                    <div key={space.space} className="space-y-1">
                      <label htmlFor={inputId} className="block text-xs font-medium">
                        {label}
                      </label>
                      <input
                        id={inputId}
                        type="url"
                        value={draft.spaceUrls[space.space] ?? ""}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          setDraft((prev) =>
                            prev
                              ? { ...prev, spaceUrls: { ...prev.spaceUrls, [space.space]: nextValue } }
                              : prev,
                          );
                        }}
                        placeholder="https://node.tinycloud.xyz"
                        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                  );
                })
              ) : (
                draft.nodeUrls.map((url, index) => {
                  const inputId = `registry-node-${index}`;
                  return (
                    <div key={inputId} className="space-y-1">
                      <label htmlFor={inputId} className="block text-xs font-medium">
                        {REGISTRY_EDITOR_COPY.labels.host} {index + 1}
                      </label>
                      <input
                        id={inputId}
                        type="url"
                        value={url}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          setDraft((prev) => {
                            if (!prev) return prev;
                            const next = [...prev.nodeUrls];
                            next[index] = nextValue;
                            return { ...prev, nodeUrls: next };
                          });
                        }}
                        placeholder="https://node.tinycloud.xyz"
                        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                  );
                })
              )}

              <div className="space-y-1">
                <label htmlFor="registry-encryption-node" className="block text-xs font-medium text-amber-800 dark:text-amber-300">
                  {REGISTRY_EDITOR_COPY.encryptionLabel}
                </label>
                <input
                  id="registry-encryption-node"
                  type="url"
                  value={draft.encryptionUrl}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setDraft((prev) => (prev ? { ...prev, encryptionUrl: nextValue } : prev));
                  }}
                  placeholder={REGISTRY_EDITOR_COPY.notSet}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              {editError && (
                <p role="alert" className="text-xs text-destructive">
                  {editError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={submitting}>
                  {REGISTRY_EDITOR_COPY.saveButton}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={cancelEditor} disabled={submitting}>
                  {REGISTRY_EDITOR_COPY.cancelButton}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Recent changes + Undo for latest row (only when OpenKey.requestRegistryChange is present) */}
      {adapter.canEdit && (historyState.phase === "error" || (historyState.phase === "loaded" && historyEntries.length > 0)) && (
        <div className="mt-4 border-t border-border pt-3" data-testid="registry-history">
          <h3 className="text-xs font-semibold tracking-tight">{REGISTRY_EDITOR_COPY.historyHeading}</h3>
          {historyState.phase === "error" && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {REGISTRY_EDITOR_COPY.historyUnavailable}
            </p>
          )}
          {historyState.phase === "loaded" && historyEntries.length > 0 && (
            <ul className="mt-2 space-y-2">
              {historyEntries.map((entry, index) => {
                const nextRecord = index === 0 ? record : (historyEntries[index - 1]?.previousRecord ?? null);
                const changes = countRecordChanges(entry.previousRecord, nextRecord);
                const formattedDate = formatRegistryDate(entry.createdAt);
                return (
                  <li
                    key={entry.id}
                    data-testid="registry-history-row"
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 break-words text-muted-foreground">
                      {REGISTRY_EDITOR_COPY.historyRow(formattedDate, entry.requestingOrigin, changes)}
                    </span>
                    {index === 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={submitting}
                        onClick={() => setUndoConfirmOpen(true)}
                        className="shrink-0 gap-1"
                      >
                        <Undo2Icon className="size-3.5" />
                        <span>{REGISTRY_EDITOR_COPY.undoButton}</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {adapter.canEdit && latestHistory && (
        <AlertDialog open={undoConfirmOpen} onOpenChange={setUndoConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{REGISTRY_EDITOR_COPY.undoConfirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {REGISTRY_EDITOR_COPY.undoConfirmBody(formatRegistryDate(latestHistory.createdAt))}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>
                {REGISTRY_EDITOR_COPY.undoConfirmCancel}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={submitting}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmUndo();
                }}
              >
                {REGISTRY_EDITOR_COPY.undoConfirmApprove}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SectionCard>
  );
}
