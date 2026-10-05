import {
  contextualCollectionPresentation,
  fundingSupersedesChallenge,
} from "@lecturn/client-runtime/state/contextual";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthRelayWriteScope,
  ExtensionFundingChallengeResult,
  type EnvironmentId,
  type ExtensionFeatureId,
  type ExtensionFundingObserveResult,
  type ExtensionHostFundingRequest,
  type ContextualSourcePolicy,
  type ContextualDataSelection,
  type ContextualDataJobReceipt,
} from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { contextualEnvironment as contextual } from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { ContextualButton as Button } from "./ContextualControls";
import {
  updateSourceSelection,
  matchesFundingChallenge,
  matchesFundingRedemption,
  FUNDING_OBSERVATION_LIMIT,
  FUNDING_OBSERVATION_INTERVAL_MS,
} from "./ContextualHostSettings.logic";

const decodeChallenge = Schema.decodeUnknownSync(ExtensionFundingChallengeResult);
const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The request could not be completed. Reconnect and try again.";
function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <Text accessibilityRole="alert" className="text-destructive">
      {message}
    </Text>
  ) : null;
}

export function ContextualHostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.contextual === true ? (
    <HostSettings key={environmentId} environmentId={environmentId} />
  ) : (
    <Text className="text-muted-foreground">Update this host to configure Contextual.</Text>
  );
}
function HostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const host =
    useEnvironments().environments.find((value) => value.environmentId === environmentId)?.label ??
    "this connected host";
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const admin =
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthAccessWriteScope) === true;
  const capture = useEnvironmentQuery(contextual.captureStatus({ environmentId, input: {} }));
  const funding = useEnvironmentQuery(
    contextual.fundingStatus({ environmentId, input: { featureId: "contextual" } }),
  );
  const setCapture = useAtomCommand(contextual.setCapture, { reportFailure: false });
  const [sources, showSources] = useState(false);
  const [archive, showArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const collection = contextualCollectionPresentation({
    capture: capture.data,
    funding: funding.data,
    captureFailed: Boolean(capture.error),
    fundingFailed: Boolean(funding.error),
  });
  return (
    <View className="gap-4">
      <Text className="font-lecturn-bold text-lg text-foreground">Collection on {host}</Text>
      <Text className="text-muted-foreground">
        Slack desktop caches are read on the host, not this phone. Saved Decisions work
        independently of Slack.
      </Text>
      <View className="rounded-xl border border-border p-4 gap-3">
        <Text className="font-lecturn-bold text-foreground">
          Local collection · {capture.data?.state ?? "Checking"}
        </Text>
        <Text className="text-muted-foreground">{collection.message}</Text>
        <Text className="text-muted-foreground">
          Pausing stops new intake. Existing permitted archive and saved Decisions remain available.
          Turning a thread off does not pause collection.
        </Text>
        {capture.data ? (
          <Text className="text-muted-foreground">
            {capture.data.capturedRecords.toLocaleString()} cached records ·{" "}
            {capture.data.coverage === "complete-for-observed-cache"
              ? "Observed cache only"
              : capture.data.coverage === "partial"
                ? "Partial coverage"
                : "Coverage unknown"}
          </Text>
        ) : null}
        {admin ? (
          <Button
            label={capture.data?.state === "running" ? "Pause collection" : "Start collection"}
            disabled={
              busy || !capture.data || (capture.data.state !== "running" && !collection.canStart)
            }
            onPress={() => {
              void (async () => {
                if (!capture.data || busy) return;
                setBusy(true);
                setError(null);
                try {
                  const result = await setCapture({
                    environmentId,
                    input: {
                      state: capture.data.state === "running" ? "paused" : "running",
                      expectedGeneration: capture.data.generation,
                    },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  capture.refresh();
                } catch (cause) {
                  setError(errorMessage(cause));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          />
        ) : (
          <Text className="text-muted-foreground">
            Source selection, collection, and raw archive access require host administration
            permission.
          </Text>
        )}
        <Button
          label="Refresh host status"
          onPress={() => {
            capture.refresh();
            funding.refresh();
          }}
        />
        <ErrorText message={error ?? capture.error ?? funding.error} />
      </View>
      {admin ? (
        <View className="gap-3">
          <Button
            label={sources ? "Hide sources" : "Discover and select sources"}
            onPress={() => showSources(!sources)}
          />
          {sources ? <SourceSelection environmentId={environmentId} /> : null}
          <Button
            label={archive ? "Close archive" : "Inspect, export, or forget archive"}
            onPress={() => showArchive(!archive)}
          />
          {archive ? <Archive environmentId={environmentId} /> : null}
        </View>
      ) : null}
      <ContextualFunding environmentId={environmentId} featureId="contextual" />
      <ContextualFunding environmentId={environmentId} featureId="decisions" />
    </View>
  );
}

function SourceSelection({ environmentId }: { environmentId: EnvironmentId }) {
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const sources = useEnvironmentQuery(
    contextual.sources({ environmentId, input: { ...(cursor ? { cursor } : {}), limit: 25 } }),
  );
  const configure = useAtomCommand(contextual.configureSources, { reportFailure: false });
  const [draft, setDraft] = useState<ContextualSourcePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const policy = draft ?? sources.data?.policy;
  const stale =
    draft !== null && sources.data !== null && draft.revision !== sources.data.policy.revision;
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-lecturn-bold text-foreground">Source selection</Text>
      <Text className="text-muted-foreground">
        Discovery previews metadata only. Older cached messages may be included; this does not fetch
        Slack history. People who operate this host can see evidence attached to its threads.
      </Text>
      <Text className="text-muted-foreground">
        Direct and group messages need individual opt-in. New conversations, drafts, and
        unclassified conversations remain excluded.
      </Text>
      {sources.isPending ? (
        <Text className="text-muted-foreground">Discovering sources…</Text>
      ) : null}
      {sources.data?.sources.length === 0 ? (
        <Text className="text-muted-foreground">
          No sources found. Slack requires a supported local desktop cache.
        </Text>
      ) : null}
      {sources.data?.sources.map((source) => {
        const selected = policy?.allowedSourceIds.includes(source.id) ?? source.selected;
        return (
          <View key={source.id} className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text className="text-foreground">{source.label}</Text>
              <Text className="text-muted-foreground">
                {source.workspaceId ? `Workspace ${source.workspaceId} · ` : ""}
                {source.sourceKind === "lecturn-decision"
                  ? "Saved Decisions · no Slack helper needed"
                  : source.conversationType === "dm" || source.conversationType === "group-dm"
                    ? `${source.conversationType} · explicit opt-in`
                    : source.conversationType}
                {!source.available ? " · unavailable" : ""}
              </Text>
            </View>
            <ThemedSwitch
              accessibilityLabel={`Include ${source.label}`}
              value={selected}
              disabled={
                busy ||
                !policy ||
                (!selected &&
                  (!source.available ||
                    source.conversationType === "unknown" ||
                    policy.allowedSourceIds.length >= 256))
              }
              onValueChange={(value) => {
                if (policy) {
                  setDraft(updateSourceSelection(policy, source, value));
                  setMessage(null);
                }
              }}
            />
          </View>
        );
      })}
      <Text className="text-muted-foreground">
        {policy?.allowedSourceIds.length ?? 0} selected across all pages · up to 256
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Previous sources"
          disabled={cursors.length <= 1 || sources.isPending}
          onPress={() => setCursors((value) => value.slice(0, -1))}
        />
        <Button
          label="Next sources"
          disabled={!sources.data?.nextCursor || sources.isPending}
          onPress={() => {
            const next = sources.data?.nextCursor;
            if (next) setCursors((value) => [...value, next]);
          }}
        />
      </View>
      {stale ? (
        <Text accessibilityRole="alert" className="text-destructive">
          Another administrator changed these sources. Discard your draft and review the current
          selection.
        </Text>
      ) : null}
      <Button
        label={busy ? "Saving…" : "Save source selection"}
        disabled={!draft || stale || busy}
        onPress={() => {
          void (async () => {
            if (!draft || stale || busy) return;
            setBusy(true);
            setError(null);
            setMessage(null);
            try {
              const result = await configure({
                environmentId,
                input: {
                  expectedRevision: draft.revision,
                  policy: { ...draft, revision: draft.revision + 1 },
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              setDraft(null);
              setMessage("Sources saved. Start collection separately when ready.");
              sources.refresh();
            } catch (cause) {
              setError(errorMessage(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
      <Button
        label={draft ? "Discard changes and refresh" : "Refresh discovery"}
        disabled={busy}
        onPress={() => {
          setDraft(null);
          sources.refresh();
        }}
      />
      {message ? <Text className="text-foreground">{message}</Text> : null}
      <ErrorText message={error ?? sources.error} />
    </View>
  );
}

function Archive({ environmentId }: { environmentId: EnvironmentId }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const sources = useEnvironmentQuery(
    contextual.sources({ environmentId, input: { ...(cursor ? { cursor } : {}), limit: 25 } }),
  );
  const capture = useEnvironmentQuery(contextual.captureStatus({ environmentId, input: {} }));
  const [source, setSource] = useState<{ id: string; label: string } | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; sourceId: string } | null>(null);
  const inspect = useEnvironmentQuery(
    search
      ? contextual.inspect({
          environmentId,
          input: { query: search.query, sourceIds: [search.sourceId], limit: 24 },
        })
      : null,
  );
  const exportData = useAtomCommand(contextual.export, { reportFailure: false });
  const forget = useAtomCommand(contextual.forget, { reportFailure: false });
  const download = useAtomCommand(contextual.downloadExport, { reportFailure: false });
  const [receipt, setReceipt] = useState<ContextualDataJobReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function manage(operation: "export" | "forget", selection: ContextualDataSelection) {
    if (!capture.data || busy) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const input = {
        actionId: randomUUID(),
        selection,
        expectedSourceGeneration: inspect.data?.sourceGeneration ?? capture.data.sourceGeneration,
        expectedPurgeGeneration: inspect.data?.purgeGeneration ?? capture.data.purgeGeneration,
      };
      const result =
        operation === "export"
          ? await exportData({ environmentId, input })
          : await forget({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setReceipt(result.value);
      if (operation === "forget") setSearch(null);
      capture.refresh();
      sources.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function confirmForget(selection: ContextualDataSelection, label: string) {
    Alert.alert(
      `Forget ${label}?`,
      "Stored content and derived data will be purged and suppressed against recapture. Linked Decisions will not automatically resupply forgotten evidence; saved notes remain. Evidence already sent to an agent cannot be retracted.",
      [
        { text: "Keep data", style: "cancel" },
        {
          text: "Forget stored data",
          style: "destructive",
          onPress: () => {
            void manage("forget", selection);
          },
        },
      ],
    );
  }
  async function shareExport(artifactId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    let file: File | null = null;
    try {
      if (!(await Sharing.isAvailableAsync()))
        throw new Error("File sharing is not available on this device.");
      const result = await download({ environmentId, input: { artifactId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      file = new File(Paths.cache, `lecturn-contextual-${randomUUID()}.ndjson`);
      file.write(new Uint8Array(result.value));
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/x-ndjson",
        UTI: "public.plain-text",
        dialogTitle: "Save Contextual export",
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      try {
        if (file?.exists) file.delete();
      } catch (cause) {
        setError(errorMessage(cause));
      }
      setBusy(false);
    }
  }
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-lecturn-bold text-foreground">Local archive</Text>
      <Text className="text-muted-foreground">
        Inspect, export, and forget remain available without paid access. Choose a source to search
        stored exchanges.
      </Text>
      {sources.data?.sources.map((entry) => (
        <Button
          key={entry.id}
          label={`${source?.id === entry.id ? "Selected: " : ""}${entry.label}`}
          disabled={busy}
          onPress={() => {
            setSource(entry);
            setSearch(null);
            setReceipt(null);
          }}
        />
      ))}
      {sources.data?.sources.length === 0 ? (
        <Text className="text-muted-foreground">No archive sources found.</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="First sources"
          disabled={!cursor || sources.isPending}
          onPress={() => setCursor(undefined)}
        />
        <Button
          label="More sources"
          disabled={!sources.data?.nextCursor || sources.isPending}
          onPress={() => setCursor(sources.data?.nextCursor ?? undefined)}
        />
      </View>
      {source ? (
        <>
          <Text className="text-foreground">Selected: {source.label}</Text>
          <TextInput
            accessibilityLabel="Search stored exchanges"
            placeholder="Keyword, issue, or decision"
            value={query}
            onChangeText={setQuery}
            maxLength={1000}
            className="min-h-11 rounded-lg border border-border px-3 text-foreground"
          />
          <Button
            label="Search archive"
            disabled={busy || inspect.isPending}
            onPress={() => {
              setSearch({ query: query.trim(), sourceId: source.id });
              inspect.refresh();
            }}
          />
          <Button
            label="Export selected source"
            disabled={busy || !capture.data}
            onPress={() => {
              void manage("export", { kind: "sources", sourceIds: [source.id] });
            }}
          />
          <Button
            label="Forget selected source…"
            disabled={busy || !capture.data}
            onPress={() => confirmForget({ kind: "sources", sourceIds: [source.id] }, source.label)}
          />
        </>
      ) : null}
      {receipt ? (
        <View className="gap-2">
          <Text className="text-foreground">
            {receipt.operation} {receipt.state} · {receipt.affectedRecords} records
          </Text>
          {receipt.state === "accepted" || receipt.state === "running" ? (
            <Text className="text-muted-foreground">
              The host is processing this request; it has not completed yet.
            </Text>
          ) : null}
          {receipt.state === "completed" && receipt.artifactId ? (
            <Button
              label="Download and share NDJSON"
              disabled={busy}
              onPress={() => {
                if (receipt.artifactId) void shareExport(receipt.artifactId);
              }}
            />
          ) : null}
        </View>
      ) : null}
      {inspect.isPending ? <Text className="text-muted-foreground">Searching archive…</Text> : null}
      {search && inspect.data ? (
        <>
          <Text className="text-muted-foreground">
            {inspect.data.candidates.length} exchanges, up to 24. Narrow the search for other
            records.
            {!inspect.data.coverage.complete || inspect.data.coverage.truncated
              ? " Partial coverage."
              : ""}{" "}
            {inspect.data.coverage.unexaminedCount} candidates unexamined.
          </Text>
          {inspect.data.candidates.map((candidate) => (
            <View key={candidate.id} className="gap-2 border-t border-border py-3">
              <Text className="font-lecturn-bold text-foreground">
                {candidate.sourceKind === "slack" ? "Slack exchange" : "Saved Decision"}
              </Text>
              {candidate.coverage.missingAntecedents ? (
                <Text className="text-muted-foreground">Missing conversation context</Text>
              ) : null}
              {candidate.evidence.map((evidence) => (
                <View key={evidence.id} className="gap-1">
                  <Text className="text-muted-foreground">
                    {evidence.author} · {evidence.occurredAt} · {evidence.availability}
                  </Text>
                  <Text selectable className="text-foreground">
                    {evidence.quote}
                  </Text>
                </View>
              ))}
              <Button
                label="Export exchange"
                disabled={busy}
                onPress={() => {
                  void manage("export", {
                    kind: "items",
                    sourceId: candidate.sourceId,
                    occurrenceIds: [candidate.occurrenceId],
                  });
                }}
              />
              <Button
                label="Forget exchange…"
                disabled={busy}
                onPress={() =>
                  confirmForget(
                    {
                      kind: "items",
                      sourceId: candidate.sourceId,
                      occurrenceIds: [candidate.occurrenceId],
                    },
                    "this exchange",
                  )
                }
              />
            </View>
          ))}
        </>
      ) : null}
      <ErrorText message={error ?? sources.error ?? inspect.error ?? capture.error} />
    </View>
  );
}

/** Each mounted leaf owns one environment/feature request, including across browser returns. */
export function ContextualFunding(props: {
  environmentId: EnvironmentId;
  featureId: ExtensionFeatureId;
}) {
  return <Funding key={`${props.environmentId}:${props.featureId}`} {...props} />;
}
function Funding({
  environmentId,
  featureId,
}: {
  environmentId: EnvironmentId;
  featureId: ExtensionFeatureId;
}) {
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const canFund =
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthRelayWriteScope) === true;
  const funding = useEnvironmentQuery(
    contextual.fundingStatus({ environmentId, input: { featureId } }),
  );
  const command = useAtomCommand(contextual.funding, { reportFailure: false });
  const host =
    useEnvironments().environments.find((value) => value.environmentId === environmentId)?.label ??
    "this connected host";
  const name = featureId === "contextual" ? "Contextual" : "Decisions";
  const storageKey = `lecturn.funding.${Array.from(environmentId)
    .map((c) => c.charCodeAt(0).toString(16))
    .join("-")}.${featureId}`;
  const [pending, setPending] = useState<ExtensionFundingChallengeResult | null>(null);
  const [pendingState, setPendingState] = useState<ExtensionFundingObserveResult["state"] | null>(
    null,
  );
  const [payer, setPayer] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const pendingId = useRef(pending?.challengeId);
  pendingId.current = pending?.challengeId;
  const locked = useRef(false);
  const allowed = useRef(canFund);
  useEffect(() => {
    allowed.current = canFund;
  }, [canFund]);
  useEffect(() => {
    active.current = true;
    void (async () => {
      try {
        const value = await SecureStore.getItemAsync(storageKey);
        if (!active.current || !value) return;
        const challenge = decodeChallenge(JSON.parse(value));
        if (challenge.environmentId !== environmentId || challenge.featureId !== featureId)
          throw new Error("Stored approval belongs to another host or feature.");
        setPending(challenge);
        setPendingState(
          Date.parse(challenge.expiresAt) <= Date.now() ? "expired" : "awaiting-approval",
        );
      } catch (cause) {
        if (active.current) setError(errorMessage(cause));
      } finally {
        if (active.current) setReady(true);
      }
    })();
    return () => {
      active.current = false;
    };
  }, [storageKey, environmentId, featureId]);
  const refresh = funding.refresh;
  useEffect(() => {
    if (!pending || funding.error || !fundingSupersedesChallenge(pending, funding.data)) return;
    pendingId.current = undefined;
    setPending(null);
    setPendingState(null);
    setPayer(null);
    setError(null);
    void SecureStore.deleteItemAsync(storageKey).catch(() => {
      // A retained obsolete challenge is reconciled against current funding again on reopening.
    });
  }, [pending, funding.data, funding.error, storageKey]);
  const waiting = pendingState === "awaiting-approval" || pendingState === "approved-awaiting-host";
  const check = useCallback(async () => {
    if (!pending || !waiting || !allowed.current || locked.current || !active.current) return;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      setPendingState("expired");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const input = {
        featureId,
        challengeId: pending.challengeId,
        expectedGeneration: pending.generation,
      };
      const observed = await command({ environmentId, input: { ...input, operation: "observe" } });
      if (!active.current || !allowed.current || pendingId.current !== pending.challengeId) return;
      if (observed._tag === "Failure") throw squashAtomCommandFailure(observed);
      if ("allowance" in observed.value && matchesFundingRedemption(pending, observed.value)) {
        setPendingState("linked");
        setPayer(observed.value.accountLabel);
        await SecureStore.deleteItemAsync(storageKey);
        refresh();
        return false;
      }
      if (
        !("challengeId" in observed.value) ||
        !("state" in observed.value) ||
        !matchesFundingChallenge(pending, observed.value)
      )
        throw new Error("Approval request changed. Start a new request.");
      setPendingState(observed.value.state);
      setPayer(observed.value.accountLabel);
      if (observed.value.state === "approved-awaiting-host") {
        const redeemed = await command({ environmentId, input: { ...input, operation: "redeem" } });
        if (!active.current || !allowed.current || pendingId.current !== pending.challengeId)
          return;
        if (redeemed._tag === "Failure") throw squashAtomCommandFailure(redeemed);
        if (!("allowance" in redeemed.value) || !matchesFundingRedemption(pending, redeemed.value))
          throw new Error("Host funding changed. Refresh its status.");
        setPendingState("linked");
        setPayer(redeemed.value.accountLabel);
        await SecureStore.deleteItemAsync(storageKey);
      } else if (observed.value.state !== "awaiting-approval")
        await SecureStore.deleteItemAsync(storageKey);
      refresh();
      return observed.value.state === "awaiting-approval";
    } catch (cause) {
      if (active.current && pendingId.current === pending.challengeId) {
        refresh();
        setError(errorMessage(cause));
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
    return false;
  }, [pending, waiting, command, environmentId, featureId, storageKey, refresh]);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checks = 0;
    const observe = async () => {
      if (canceled || AppState.currentState !== "active" || checks >= FUNDING_OBSERVATION_LIMIT)
        return;
      checks += 1;
      const waitingForApproval = await check();
      if (!canceled && waitingForApproval && checks < FUNDING_OBSERVATION_LIMIT)
        timer = setTimeout(() => {
          void observe();
        }, FUNDING_OBSERVATION_INTERVAL_MS);
    };
    if (ready && canFund && pending && waiting)
      timer = setTimeout(() => {
        void observe();
      }, 0);
    const subscription = AppState.addEventListener("change", (state) => {
      if (timer) clearTimeout(timer);
      if (state === "active" && ready && canFund && pending && waiting) void observe();
    });
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [ready, canFund, pending, waiting, check]);
  async function openApproval() {
    if (!pending || !canFund) return;
    try {
      await WebBrowser.openBrowserAsync(pending.approvalUrl);
      await check();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    }
  }
  async function act(operation: "create" | "cancel" | "revoke") {
    if (!funding.data || !allowed.current || locked.current || !ready) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      let input: ExtensionHostFundingRequest;
      if (operation === "cancel") {
        if (!pending) return;
        input = {
          featureId,
          operation,
          challengeId: pending.challengeId,
          expectedGeneration: pending.generation,
        };
      } else input = { featureId, operation, expectedGeneration: funding.data.generation };
      const result = await command({ environmentId, input });
      if (!active.current || !allowed.current) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (operation === "create") {
        if (
          !("approvalUrl" in result.value) ||
          result.value.environmentId !== environmentId ||
          result.value.featureId !== featureId ||
          (result.value.generation !== funding.data.generation &&
            result.value.generation !== funding.data.generation + 1)
        )
          throw new Error("The funding request changed. Refresh and try again.");
        let persisted = true;
        try {
          await SecureStore.setItemAsync(storageKey, JSON.stringify(result.value));
        } catch {
          persisted = false;
        }
        if (!active.current) return;
        setPending(result.value);
        setPendingState("awaiting-approval");
        setPayer(null);
        if (!persisted)
          throw new Error(
            "Could not save this approval request on your phone. Keep this screen open to finish linking or cancel the request.",
          );
      } else {
        await SecureStore.deleteItemAsync(storageKey);
        if (!active.current) return;
        setPending(null);
        setPendingState(null);
        setPayer(null);
      }
      refresh();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-lecturn-bold text-lg text-foreground">
        {name} membership · {funding.data?.state ?? "Checking"}
      </Text>
      <Text className="text-muted-foreground">
        Approval authorizes only {name} on {host}. The browser confirms the paying account; this
        phone completes authenticated host linking after approval. Automatic checks are bounded; use
        Check approval to retry.
      </Text>
      {funding.data?.accountLabel ? (
        <Text className="text-foreground">Membership: {funding.data.accountLabel}</Text>
      ) : null}
      {funding.data && !funding.data.eligible ? (
        <Text className="text-muted-foreground">
          {funding.data.reason === "disabled"
            ? `${name} is disabled by the service operator.`
            : funding.data.reason === "cohort"
              ? `${name} is not available to this account yet.`
              : funding.data.reason === "trial" || funding.data.reason === "not-paid"
                ? "A paid membership is required. Confirm the account on the approval page."
                : funding.data.reason === "stale-billing"
                  ? "Membership status needs to be refreshed."
                  : "Membership access is temporarily unavailable."}
        </Text>
      ) : null}
      {funding.data?.allowance ? (
        <View className="gap-1">
          <Text className="text-foreground">
            {funding.data.allowance.remainingInputTokens.toLocaleString()}{" "}
            {funding.data.state === "active" && funding.data.eligible && !funding.error
              ? "tokens remaining"
              : "tokens last reported · refresh membership status to confirm"}
          </Text>
          <Text className="text-muted-foreground">
            One monthly pool shared by Contextual and Decisions.
          </Text>
          {funding.data.allowance.byFeature.map((usage) => (
            <Text key={usage.featureId} className="text-muted-foreground">
              {usage.featureId}: {usage.usedInputTokens.toLocaleString()} used ·{" "}
              {usage.reservedInputTokens.toLocaleString()} reserved
            </Text>
          ))}
          {funding.data.state === "active" &&
          funding.data.eligible &&
          !funding.error &&
          funding.data.allowance.remainingInputTokens === 0 ? (
            <Text className="text-muted-foreground">
              Paid evaluation is paused until the shared allowance resets. Eligible local collection
              and data management remain available.
            </Text>
          ) : null}
        </View>
      ) : null}
      {funding.data?.remoteRevocationPending ? (
        <Text className="text-muted-foreground">
          Revoked on this host. Cloud revocation will be retried.
        </Text>
      ) : null}
      {canFund ? (
        <>
          {pending ? (
            <Text className="text-foreground">
              Request: {pendingState}
              {payer ? ` · Paying account: ${payer}` : ""}
            </Text>
          ) : null}
          {waiting ? (
            <>
              <Button
                label="Open approval in browser"
                disabled={busy}
                onPress={() => {
                  void openApproval();
                }}
              />
              <Button
                label="Check approval and finish linking"
                disabled={busy}
                onPress={() => {
                  void check();
                }}
              />
              <Button
                label="Cancel approval request"
                disabled={busy}
                onPress={() => {
                  void act("cancel");
                }}
              />
            </>
          ) : (
            <Button
              label={funding.data?.state === "active" ? "Change membership" : "Link membership"}
              disabled={busy || !ready || !funding.data}
              onPress={() => {
                void act("create");
              }}
            />
          )}
          {funding.data?.state === "active" ? (
            <Button
              label={`Revoke ${name} access…`}
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  `Revoke ${name} access?`,
                  `This stops ${name} from using this membership on this host. Other approved features keep their access; stored data remains available.`,
                  [
                    { text: "Keep access", style: "cancel" },
                    {
                      text: "Revoke access",
                      style: "destructive",
                      onPress: () => {
                        void act("revoke");
                      },
                    },
                  ],
                )
              }
            />
          ) : null}
        </>
      ) : (
        <Text className="text-muted-foreground">
          Membership linking requires host relay administration permission. Ask the host
          administrator to approve this feature.
        </Text>
      )}
      <Button label="Refresh allowance" disabled={busy} onPress={refresh} />
      <ErrorText message={error ?? funding.error} />
    </View>
  );
}
