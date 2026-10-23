import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@lecturn/client-runtime/errors";
import {
  type EnvironmentConnectionPresentation,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from "@lecturn/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { bucketByAccount, relayOfflineReasonMessage } from "@lecturn/client-runtime/relay";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ServerConfig,
} from "@lecturn/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@lecturn/contracts/relay";
import * as Option from "effect/Option";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { accountByEnvironmentIdAtom, connectAccountProfilesAtom } from "~/cloud/connectAccounts";
import { knownConnectAccountsAtom } from "~/cloud/knownAccounts";
import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AccountMark } from "../sidebar/AccountMark";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

const EMPTY_DISCOVERY_REFRESH_INTERVAL_MS = 5_000;

function discoveredCompatibilityError(
  status: Option.Option<RelayEnvironmentStatusResponse> | undefined,
) {
  const descriptor = status === undefined ? undefined : Option.getOrNull(status)?.descriptor;
  return descriptor === undefined ? null : orchestrationProtocolCompatibilityError(descriptor);
}

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly relayManaged: boolean;
  readonly serverConfig?: Pick<ServerConfig, "environment"> | null;
}

function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton shape="pill" className="h-4 w-32" />
          <Skeleton shape="pill" className="h-3 w-20" />
        </div>
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  );
}

export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  refreshWhileEmpty = false,
  empty = null,
  selection,
  onDiscoveryReady,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly refreshWhileEmpty?: boolean;
  readonly empty?: ReactNode;
  readonly onDiscoveryReady?: () => void;
  readonly selection?: {
    readonly autoSelectedComputers?: Set<EnvironmentId>;
    readonly selectedIds: ReadonlySet<EnvironmentId>;
    readonly onChange: (environmentId: EnvironmentId, selected: boolean) => void;
  };
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const accountStates = useAtomValue(relayEnvironmentDiscovery.accountStatesValueAtom);
  const knownAccountIds = useAtomValue(knownConnectAccountsAtom).accountIds;
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const accountByEnvironmentId = useAtomValue(accountByEnvironmentIdAtom);
  // A saved environment's owner is its catalog tag. One that is only listed
  // belongs to the account whose discovery listed it.
  const ownerOf = (environmentId: EnvironmentId) =>
    accountByEnvironmentId.get(environmentId) ??
    [...accountStates].find(([, account]) => account.environments.has(environmentId))?.[0];
  const accountHeading = (accountId: string | null) =>
    accountId === null
      ? "Other environments"
      : (profiles.get(accountId)?.label ?? profiles.get(accountId)?.email ?? "Account");
  const refreshDiscoveryWhenIdle = useEffectEvent(async () => {
    if (environmentsState.refreshing || environmentsState.offline) return;
    await refreshRelayEnvironments();
  });
  const connectRelayEnvironment = (environment: RelayClientEnvironmentRecord) => {
    // The owner is the account whose discovery listed the environment.
    const accountId = [...accountStates].find(([, account]) =>
      account.environments.has(environment.environmentId),
    )?.[0];
    return registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: environment.environmentId,
          label: environment.label,
          ...(accountId === undefined ? {} : { accountId }),
        }),
      }),
    );
  };
  const [connectingEnvironmentIds, setConnectingEnvironmentIds] = useState<
    ReadonlySet<EnvironmentId>
  >(new Set());
  const savedById = new Map(
    savedEnvironments
      .filter((environment) => environment.relayManaged)
      .map((environment) => [environment.environmentId, environment]),
  );
  const savedWithoutRelay = new Set(
    savedEnvironments
      .filter((environment) => !environment.relayManaged)
      .map((environment) => environment.environmentId),
  );

  useEffect(() => {
    let active = true;
    if (onDiscoveryReady || !refreshWhileEmpty || document.visibilityState === "visible") {
      void refreshRelayEnvironments().then(() => {
        if (active) onDiscoveryReady?.();
      });
    }
    return () => {
      active = false;
    };
  }, [refreshRelayEnvironments, refreshWhileEmpty, onDiscoveryReady]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    if (
      discoveredCompatibilityError(
        environmentsState.environments.get(environment.environmentId)?.status,
      ) !== null
    )
      return false;
    setConnectingEnvironmentIds((current) => new Set([...current, environment.environmentId]));
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentIds((current) => {
      const next = new Set(current);
      next.delete(environment.environmentId);
      return next;
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: savedWithoutRelay.has(environment.environmentId)
          ? "Lecturn Connect route added"
          : "Environment added",
        description: savedWithoutRelay.has(environment.environmentId)
          ? `${environment.label} falls back to Lecturn Connect when its other routes are unreachable.`
          : `Connecting to ${environment.label} through Lecturn Connect.`,
      });
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      return false;
    }
    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error ? cause.message : "Could not connect the Lecturn Connect environment.";
    const traceId = findErrorTraceId(cause);
    console.error("[lecturn-connect] Could not connect environment", { message, traceId, cause });
    toastManager.add({
      type: "error",
      title: "Could not connect environment",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
    return false;
  };

  // During onboarding selection a machine saved over another route already
  // has its own row elsewhere, and selecting it must not add a Lecturn Connect
  // route as a side effect, so it is left out here.
  const isVisibleEnvironment = (environmentId: EnvironmentId) =>
    environmentId !== primaryEnvironmentId &&
    (showSavedEnvironments || !savedById.has(environmentId)) &&
    !(selection && savedWithoutRelay.has(environmentId));
  const discoveredEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) => isVisibleEnvironment(environment.environmentId),
  );
  // Saved selections must remain editable when their account cannot list them.
  const visibleEnvironments = [
    ...discoveredEnvironments,
    ...(showSavedEnvironments && selection
      ? savedEnvironments
          .filter(
            ({ environmentId, relayManaged }) =>
              relayManaged &&
              environmentId !== primaryEnvironmentId &&
              !environmentsState.environments.has(environmentId),
          )
          .map(({ environmentId, label }) => ({
            environment: { environmentId, label },
            availability: "offline" as const,
            error: Option.none(),
            status: undefined,
          }))
      : []),
  ];
  const selectNewComputers = useEffectEvent(
    (environments: typeof environmentsState.environments) => {
      const seen = selection?.autoSelectedComputers;
      if (!selection || !seen) return;
      for (const { environment, status, availability } of environments.values()) {
        if (!isVisibleEnvironment(environment.environmentId)) continue;
        const id = environment.environmentId;
        if (availability === "checking") continue;
        if (
          discoveredCompatibilityError(status) !== null ||
          savedById.get(id)?.connection.phase === "unsupported"
        ) {
          seen.add(id);
          if (selection.selectedIds.has(id)) selection.onChange(id, false);
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        selection.onChange(id, true);
        if (!savedById.has(id)) {
          void connectEnvironment(environment).then((connected) => {
            if (!connected) selection.onChange(id, false);
          });
        }
      }
    },
  );
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Discovery results arrive from an external store and auto-selection starts relay connections, which mark themselves connecting.
    selectNewComputers(environmentsState.environments);
  }, [environmentsState.environments]);

  // Discovery clears its list on refresh, so poll only until a machine appears.
  const shouldRefreshWhileEmpty =
    refreshWhileEmpty && discoveredEnvironments.length === 0 && !environmentsState.offline;

  useEffect(() => {
    if (!shouldRefreshWhileEmpty) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let pending = false;
    const visible = () => document.visibilityState === "visible";
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && visible()) {
        timer = setTimeout(() => void refresh(), EMPTY_DISCOVERY_REFRESH_INTERVAL_MS);
      }
    };
    const refresh = async () => {
      if (disposed || pending || !visible()) return;
      clearTimeout(timer);
      pending = true;
      await settlePromise(() => refreshDiscoveryWhenIdle());
      pending = false;
      schedule();
    };
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (visible()) void refresh();
    };

    schedule();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [shouldRefreshWhileEmpty]);

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    !refreshWhileEmpty &&
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    const discoveryProblem = environmentsState.offline
      ? "You appear to be offline."
      : (Option.getOrNull(environmentsState.error)?.message ?? null);
    if (discoveryProblem !== null && !environmentsState.refreshing) {
      return (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-sm font-medium text-destructive">
            Could not load Lecturn Connect environments
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{discoveryProblem}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void refreshRelayEnvironments()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return empty;
  }

  const renderRow = ({
    environment,
    availability,
    error,
    status,
  }: (typeof visibleEnvironments)[number]) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const compatibilityError = discoveredCompatibilityError(status);
    const unsupported =
      compatibilityError !== null || savedEnvironment?.connection.phase === "unsupported";
    const unsupportedDetail =
      compatibilityError?.message ?? savedEnvironment?.connection.error ?? null;
    const savedConnection = unsupported
      ? presentSavedCloudEnvironmentConnection({
          phase: "unsupported",
          error: unsupportedDetail,
          traceId: null,
        })
      : savedEnvironment
        ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
        : null;
    const relayStatus = status === undefined ? null : Option.getOrNull(status);
    const descriptor = relayStatus?.descriptor;
    const offlineReason =
      availability === "offline" && relayStatus !== null
        ? relayOfflineReasonMessage(relayStatus)
        : null;
    const machineKind = resolveEnvironmentMachineKind(
      savedEnvironment?.serverConfig ??
        (descriptor === undefined ? null : { environment: descriptor }),
    );
    const dotClassName = savedConnection
      ? savedConnection.tone === "connected"
        ? "bg-success"
        : savedConnection.tone === "connecting"
          ? "bg-warning"
          : savedConnection.tone === "error"
            ? "bg-destructive"
            : "bg-muted-foreground/35"
      : availability === "online"
        ? "bg-success"
        : availability === "error"
          ? "bg-destructive"
          : availability === "checking"
            ? "bg-warning"
            : "bg-muted-foreground/35";
    const notAdded = savedWithoutRelay.has(environment.environmentId)
      ? "Saved without Lecturn Connect"
      : "Not added";
    const statusText =
      unsupported && !savedEnvironment
        ? `Lecturn Connect · ${notAdded} · Client not supported`
        : offlineReason !== null
          ? offlineReason
          : savedConnection
            ? savedConnection.statusText
            : availability === "online"
              ? `Lecturn Connect · ${notAdded} · Relay online`
              : availability === "offline"
                ? `Lecturn Connect · ${notAdded} · Relay offline`
                : availability === "checking"
                  ? `Lecturn Connect · ${notAdded} · Checking relay status…`
                  : (Option.getOrNull(error)?.message ??
                    `Lecturn Connect · ${notAdded} · Relay status unavailable`);
    if (selection) {
      return (
        <label
          key={environment.environmentId}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 has-disabled:cursor-default"
        >
          <Checkbox
            checked={!unsupported && selection.selectedIds.has(environment.environmentId)}
            disabled={unsupported || connectingEnvironmentIds.has(environment.environmentId)}
            onCheckedChange={async (checked) => {
              if (unsupported) return;
              selection.onChange(environment.environmentId, checked);
              const discovered = environmentsState.environments.get(environment.environmentId);
              if (checked && !savedEnvironment && discovered) {
                const connected = await connectEnvironment(discovered.environment);
                if (!connected) selection.onChange(environment.environmentId, false);
              }
            }}
          />
          <EnvironmentMachineIcon
            aria-hidden
            kind={machineKind}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{environment.label}</span>
          <AccountMark environmentId={environment.environmentId} />
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={0} />}
              className={cn(
                "max-w-[45%] shrink-0 truncate text-xs",
                savedConnection?.tone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {connectingEnvironmentIds.has(environment.environmentId)
                ? "Connecting…"
                : (savedConnection?.buttonLabel ??
                  (availability === "online"
                    ? "Available"
                    : availability === "offline"
                      ? "Offline"
                      : availability === "error"
                        ? "Unavailable"
                        : "Checking…"))}
            </TooltipTrigger>
            <TooltipPopup>{unsupportedDetail ?? statusText}</TooltipPopup>
          </Tooltip>
        </label>
      );
    }
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={dotClassName}
                pingClassName={
                  savedConnection?.tone === "connecting" ||
                  (savedConnection === null && availability === "checking")
                    ? "bg-warning/60 duration-2000"
                    : null
                }
                tooltipText={
                  unsupportedDetail !== null
                    ? unsupportedDetail
                    : offlineReason !== null
                      ? offlineReason
                      : savedConnection
                        ? savedConnection.statusText
                        : availability === "online"
                          ? "Relay online"
                          : availability === "offline"
                            ? "Relay offline"
                            : availability === "checking"
                              ? "Checking relay status"
                              : (Option.getOrNull(error)?.message ?? "Relay status unavailable")
                }
              />
              <EnvironmentMachineIcon
                aria-hidden
                kind={machineKind}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
              <AccountMark environmentId={environment.environmentId} />
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                savedConnection?.tone === "error" ||
                  (savedConnection?.tone === "connecting" && savedEnvironment?.connection.error) ||
                  (savedConnection === null && availability === "error")
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          </div>
          {unsupported && !savedEnvironment ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
                <Button size="sm" disabled>
                  Add
                </Button>
              </TooltipTrigger>
              <TooltipPopup>{unsupportedDetail ?? "Client not supported"}</TooltipPopup>
            </Tooltip>
          ) : savedConnection ? (
            <Button size="sm" variant="outline" disabled>
              {savedConnection.buttonLabel}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={connectingEnvironmentIds.size > 0}
              onClick={() => {
                const discovered = environmentsState.environments.get(environment.environmentId);
                if (discovered) void connectEnvironment(discovered.environment);
              }}
            >
              {connectingEnvironmentIds.has(environment.environmentId)
                ? "Adding…"
                : savedWithoutRelay.has(environment.environmentId)
                  ? "Add route"
                  : "Add"}
            </Button>
          )}
        </div>
      </div>
    );
  };

  // With two or more accounts known, each account's environments sit under its label.
  if (knownAccountIds.length >= 2) {
    return bucketByAccount(
      visibleEnvironments,
      ({ environment }) => ownerOf(environment.environmentId),
      knownAccountIds,
    ).map((bucket) => (
      <section key={bucket.accountId ?? "none"} aria-label={accountHeading(bucket.accountId)}>
        <p className="px-3 pt-3 font-medium text-muted-foreground text-xs sm:px-4">
          {accountHeading(bucket.accountId)}
        </p>
        {bucket.items.map(renderRow)}
      </section>
    ));
  }

  return visibleEnvironments.map(renderRow);
}
