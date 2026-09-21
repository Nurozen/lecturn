import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@lecturn/client-runtime/errors";
import {
  type EnvironmentConnectionPresentation,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@lecturn/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { bucketByAccount } from "@lecturn/client-runtime/relay";
import type { EnvironmentId } from "@lecturn/contracts";
import type { RelayClientEnvironmentRecord } from "@lecturn/contracts/relay";
import * as Option from "effect/Option";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { accountByEnvironmentIdAtom, connectAccountProfilesAtom } from "~/cloud/connectAccounts";
import { knownConnectAccountsAtom } from "~/cloud/knownAccounts";
import { connectMultiAccount } from "~/cloud/publicConfig";
import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { AccountMark } from "../sidebar/AccountMark";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
}

export function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
    </div>
  );
}

/**
 * The user's Lecturn Connect environments from relay discovery, each with a
 * Connect button. The primary environment is always excluded; already-saved
 * environments are hidden unless `showSavedEnvironments` renders them with
 * their live connection state (used by onboarding, where the full device mesh
 * should be visible).
 */
export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  empty = null,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly empty?: ReactNode;
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
  const ownerOf = useCallback(
    (environmentId: EnvironmentId) =>
      accountByEnvironmentId.get(environmentId) ??
      [...accountStates].find(([, account]) => account.environments.has(environmentId))?.[0],
    [accountByEnvironmentId, accountStates],
  );
  const accountHeading = (accountId: string | null) =>
    accountId === null ? "Other environments" : (profiles.get(accountId)?.email ?? "Account");
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) => {
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
    },
    [accountStates, registerEnvironment],
  );
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const savedById = new Map(
    savedEnvironments.map((environment) => [environment.environmentId, environment]),
  );

  useEffect(() => {
    void refreshRelayEnvironments();
  }, [refreshRelayEnvironments]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentId(environment.environmentId);
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Environment added",
        description: `Connecting to ${environment.label} through Lecturn Connect.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
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
  };

  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) =>
      environment.environmentId !== primaryEnvironmentId &&
      (showSavedEnvironments || !savedById.has(environment.environmentId)),
  );

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    // A failed or offline discovery is not "no environments" — misreporting it
    // as empty would read as the user's devices having disappeared.
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
  }: (typeof visibleEnvironments)[number]) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const savedConnection = savedEnvironment
      ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
      : null;
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
    const statusText = savedConnection
      ? savedConnection.statusText
      : availability === "online"
        ? "Available · Relay online"
        : availability === "offline"
          ? "Available · Relay offline"
          : availability === "checking"
            ? "Available · Checking relay status…"
            : (Option.getOrNull(error)?.message ?? "Available · Relay status unavailable");
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
                  savedConnection
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
          {savedConnection ? (
            <Button size="sm" variant="outline" disabled>
              {savedConnection.buttonLabel}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={connectingEnvironmentId !== null}
              onClick={() => void connectEnvironment(environment)}
            >
              {connectingEnvironmentId === environment.environmentId ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </div>
    );
  };

  // With two or more accounts known, each account's environments sit under its email.
  if (connectMultiAccount && knownAccountIds.length >= 2) {
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
