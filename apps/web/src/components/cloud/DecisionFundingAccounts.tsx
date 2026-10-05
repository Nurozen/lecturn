import type { DecisionFundedEnvironment } from "@lecturn/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { decisionFundingAccountsClient } from "../../cloud/decisionFundingAccounts";
import { Button } from "../ui/button";

export function DecisionFundingAccounts({ accountId }: { accountId: string }) {
  return <AccountFunding key={accountId} accountId={accountId} />;
}
function AccountFunding({ accountId }: { accountId: string }) {
  const [rows, setRows] = useState<ReadonlyArray<DecisionFundedEnvironment>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DecisionFundedEnvironment | null>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const load = useCallback(
    async (next?: string) => {
      controller.current?.abort();
      const operation = new AbortController();
      controller.current = operation;
      setPending(true);
      setError(null);
      setConfirm(null);
      try {
        const result = await decisionFundingAccountsClient().list(
          accountId,
          next,
          operation.signal,
        );
        if (!active.current || operation.signal.aborted) return;
        setRows((previous) =>
          next
            ? [
                ...previous,
                ...result.environments.filter(
                  (row) => !previous.some((item) => item.environmentId === row.environmentId),
                ),
              ]
            : result.environments,
        );
        setCursor(result.nextCursor);
        setLoaded(true);
      } catch {
        if (active.current && !operation.signal.aborted)
          setError("Funded hosts could not be loaded. Refresh or sign in again.");
      } finally {
        if (active.current && !operation.signal.aborted) setPending(false);
      }
    },
    [accountId],
  );
  useEffect(() => {
    active.current = true;
    // Defer the external request so Strict Mode cleanup can cancel its first mount.
    queueMicrotask(() => {
      if (active.current) void load();
    });
    return () => {
      active.current = false;
      controller.current?.abort();
    };
    // The keyed child is recreated for every selected account.
  }, [load]);
  async function revoke() {
    if (!confirm || pending) return;
    const target = confirm;
    const operation = new AbortController();
    controller.current = operation;
    setPending(true);
    setError(null);
    try {
      await decisionFundingAccountsClient().revoke(
        accountId,
        { environmentId: target.environmentId, expectedGeneration: target.generation },
        operation.signal,
      );
      if (!active.current || operation.signal.aborted) return;
      setRows((previous) => previous.filter((row) => row.environmentId !== target.environmentId));
      setConfirm(null);
    } catch {
      if (active.current && !operation.signal.aborted)
        setError(
          "Funding could not be revoked. Refresh to check whether it changed, then try again.",
        );
    } finally {
      if (active.current && !operation.signal.aborted) setPending(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="Decisions funding">
      <h3 className="font-medium">Decisions funding</h3>
      <p className="text-sm text-muted-foreground">
        Hosts using this account’s Decisions allowance. You can stop funding a host without access
        to its connection.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loaded && pending && <p role="status">Loading funded hosts…</p>}
      {loaded && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">This account is not funding any hosts.</p>
      )}
      {rows.map((row) => (
        <div key={row.environmentId} className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">{row.environmentLabel}</p>
          <p className="break-all text-xs text-muted-foreground">{row.environmentId}</p>
          {confirm?.environmentId === row.environmentId ? (
            <div
              role="group"
              aria-label={`Confirm stop funding ${row.environmentLabel}`}
              className="space-y-2"
            >
              <p className="text-sm">
                Stop this host from using your Decisions allowance? Existing notes remain available.
              </p>
              <div className="flex gap-2">
                <Button disabled={pending} onClick={() => void revoke()}>
                  Confirm stop funding
                </Button>
                <Button variant="outline" disabled={pending} onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(row)}>
              Stop funding
            </Button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={() => void load()}>
          Refresh funded hosts
        </Button>
        {cursor && (
          <Button variant="outline" disabled={pending} onClick={() => void load(cursor)}>
            Load more hosts
          </Button>
        )}
      </div>
    </section>
  );
}
