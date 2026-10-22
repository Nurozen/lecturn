import { GlassCard } from "../../components/GlassCard";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { SymbolView } from "../../components/AppSymbol";
import {
  connectionStatusText,
  relayRouteTarget,
  type EnvironmentConnectionPhase,
} from "@lecturn/client-runtime/connection";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentDescriptor,
  resolveEnvironmentMachineKind,
} from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useState } from "react";
import { Pressable, type TextLayoutEvent, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { availableCloudEnvironmentPresentation } from "../cloud/cloudEnvironmentPresentation";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectAccounts } from "../cloud/knownAccounts";
import { accountTintColor } from "@lecturn/shared/accountTint";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { type RelayEnvironmentView, useConnectionController } from "./useConnectionController";

interface CloudEnvironmentRowsProps {
  readonly accountId?: string;
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onOpenEnvironment?: (environmentId: EnvironmentId) => void;
  readonly onSetEnvironmentEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  /** Long-press on a saved row. The callback owns the confirm. */
  readonly onRemoveEnvironment: (environmentId: EnvironmentId) => void;
  readonly showcaseAvailableEnvironments?: ReadonlyArray<RelayEnvironmentView>;
  readonly showcaseSignedIn?: boolean;
  /**
   * Hide the "Lecturn Connect" section title when the host provides its own header.
   */
  readonly showHeader?: boolean;
}

/**
 * "Lecturn Connect" section: every environment published to the signed-in account,
 * with connect switches, availability status, and loading/error
 * states. Shared between the Settings environments screen and the Lecturn Connect
 * onboarding sheet.
 *
 * Already-connected relay environments render even without cloud config or a
 * signed-in account — they are registered on this device and must stay
 * reachable and removable. Only discovery (the available list, refresh, and
 * its errors) requires a signed-in session.
 */
export function CloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  // Showcase captures run without a Clerk publishable key, so `ClerkProvider`
  // is never mounted and any `useAuth` call throws — the fixture states whether
  // the rows are signed in instead of asking Clerk.
  if (props.showcaseSignedIn !== undefined) {
    return props.showcaseSignedIn ? <CloudEnvironmentRowsContent {...props} /> : null;
  }
  // No cloud config means no `ClerkProvider` either, so `useAuth` would throw.
  if (!hasCloudPublicConfig()) {
    return <ConnectedOnlyCloudEnvironmentRows {...props} />;
  }
  return <SignedInCloudEnvironmentRows {...props} />;
}

function SignedInCloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  const accounts = useConnectAccounts();
  if (!accounts.some((account) => account.signedIn))
    return <ConnectedOnlyCloudEnvironmentRows {...props} />;
  return <CloudEnvironmentRowsContent {...props} />;
}

function ConnectedOnlyCloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  if (props.connectedCloudEnvironments.length === 0) return null;
  return <CloudEnvironmentRowsContent {...props} discoveryAvailable={false} />;
}

function CloudEnvironmentRowsContent(
  props: CloudEnvironmentRowsProps & { readonly discoveryAvailable?: boolean },
) {
  const controller = useConnectionController();
  const accounts = useConnectAccounts();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const discoveryAvailable = props.discoveryAvailable ?? true;
  const availableCloudEnvironments = discoveryAvailable
    ? (props.showcaseAvailableEnvironments ?? controller.availableRelayEnvironments)
    : [];
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const hasCloudRows =
    props.connectedCloudEnvironments.length > 0 || availableCloudEnvironments.length > 0;

  const handleConnectCloudEnvironment = useCallback(
    (entry: RelayEnvironmentView) => controller.connectRelayEnvironment(entry.environment),
    [controller],
  );

  // The relay's health probe carries each server's descriptor, so a machine
  // can wear its detected glyph before this device ever connects to it.
  const discoveredDescriptors = new Map(
    controller.relayEnvironments.flatMap((entry) =>
      entry.status?.descriptor === undefined
        ? []
        : [[entry.environment.environmentId, entry.status.descriptor] as const],
    ),
  );

  const handleToggleCloudError = useCallback((environmentId: string) => {
    setExpandedErrorId((current) => (current === environmentId ? null : environmentId));
  }, []);

  const showHeader = props.showHeader ?? true;

  return (
    <View collapsable={false} className={cn("gap-3", showHeader && "mt-5")}>
      {showHeader ? (
        <View className="px-1">
          <Text className="text-sm font-lecturn-bold uppercase text-foreground-muted">
            Lecturn Connect
          </Text>
        </View>
      ) : null}

      {hasCloudRows ? (
        <GlassCard collapsable={false} radius={24}>
          {(props.accountId
            ? [props.accountId]
            : [...accounts.map((account) => account.accountId), null]
          ).map((accountId) => {
            const account = accounts.find((entry) => entry.accountId === accountId);
            const owns = (environmentId: EnvironmentId) => {
              const entry = catalog.entries.get(environmentId);
              return entry === undefined ? null : (relayRouteTarget(entry)?.accountId ?? null);
            };
            const connected = props.connectedCloudEnvironments.filter(
              (entry) => owns(entry.environmentId) === accountId,
            );
            const available = availableCloudEnvironments.filter(
              (entry) => (entry.accountId ?? null) === accountId,
            );
            if (!connected.length && !available.length) return null;
            return (
              <View key={accountId ?? "unowned"}>
                <View className="flex-row items-center gap-2 px-4 py-3">
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: account ? accountTintColor(account.preset) : "#888888",
                    }}
                  />
                  <Text className="text-sm font-semibold text-foreground">
                    {account?.label ?? "No account"}
                    {account && !account.signedIn ? " · Sign in again" : ""}
                  </Text>
                </View>
                {connected.map((environment, index) => (
                  <ConnectedCloudEnvironmentRow
                    key={environment.environmentId}
                    environment={environment}
                    descriptor={discoveredDescriptors.get(environment.environmentId)}
                    borderTop={index !== 0}
                    onSetEnabled={(enabled) =>
                      props.onSetEnvironmentEnabled(environment.environmentId, enabled)
                    }
                    onRemove={() => props.onRemoveEnvironment(environment.environmentId)}
                    onOpen={
                      props.onOpenEnvironment
                        ? () => props.onOpenEnvironment?.(environment.environmentId)
                        : undefined
                    }
                    errorExpanded={expandedErrorId === environment.environmentId}
                    onToggleError={() => handleToggleCloudError(environment.environmentId)}
                  />
                ))}
                {available.map((environment, index) => (
                  <CloudEnvironmentRow
                    key={environment.environment.environmentId}
                    environment={environment}
                    borderTop={connected.length > 0 || index !== 0}
                    showChevron={props.onOpenEnvironment !== undefined}
                    onConnect={() => handleConnectCloudEnvironment(environment)}
                    errorExpanded={expandedErrorId === environment.environment.environmentId}
                    onToggleError={() =>
                      handleToggleCloudError(environment.environment.environmentId)
                    }
                  />
                ))}
              </View>
            );
          })}
        </GlassCard>
      ) : controller.relayDiscovery.isRefreshing ? (
        <GlassCard collapsable={false} radius={24} className="items-center gap-3 p-6">
          <AppActivityIndicator colorClassName={"accent-icon"} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Loading linked cloud environments.
          </Text>
        </GlassCard>
      ) : controller.relayDiscovery.error ? null : (
        <GlassCard collapsable={false} radius={24} className="p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            No additional linked cloud environments.
          </Text>
        </GlassCard>
      )}

      {/* Rendered alongside any connected rows — a failed discovery must not
          hide behind an otherwise-healthy list. */}
      {discoveryAvailable &&
      controller.relayDiscovery.error &&
      !controller.relayDiscovery.isRefreshing ? (
        <GlassCard collapsable={false} radius={24} className="gap-3 p-5">
          <Text className="text-base font-lecturn-bold text-foreground">
            Could not load Lecturn Connect environments
          </Text>
          <Text className="text-sm text-foreground-muted">{controller.relayDiscovery.error}</Text>
          {controller.relayDiscovery.errorTraceId ? (
            <CopyTraceIdButton traceId={controller.relayDiscovery.errorTraceId} />
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void controller.refreshRelayEnvironments();
            }}
            className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
          >
            <Text className="text-xs font-lecturn-bold text-foreground">Try again</Text>
          </Pressable>
        </GlassCard>
      ) : null}
    </View>
  );
}

/**
 * A saved Lecturn Connect environment. The switch turns it on or off; off keeps the
 * registration and cache but drops the connection and hides its errors.
 * Long-press removes it from this device.
 */
function ConnectedCloudEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  /** Discovery's view of the server, for the glyph before the first connection. */
  readonly descriptor: ExecutionEnvironmentDescriptor | undefined;
  readonly borderTop: boolean;
  readonly errorExpanded: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onToggleError: () => void;
}) {
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.environment.environmentId),
  );
  const unsupported = props.environment.connectionState === "unsupported";
  const enabled = props.environment.isEnabled && !unsupported;
  // Discovery empties its map on every refresh; hold the last descriptor seen
  // so the glyph does not blink back to the generic one each time.
  const [lastDescriptor, setLastDescriptor] = useState(props.descriptor);
  if (props.descriptor !== undefined && props.descriptor !== lastDescriptor) {
    setLastDescriptor(props.descriptor);
  }
  return (
    <Pressable
      accessibilityHint="Long press to remove from this device"
      accessibilityRole={props.onOpen ? "button" : undefined}
      accessibilityLabel={props.onOpen ? `Manage ${props.environment.environmentLabel}` : undefined}
      onPress={props.onOpen}
      onLongPress={props.onRemove}
    >
      <CloudEnvironmentRowShell
        borderTop={props.borderTop}
        opensDetails={props.onOpen !== undefined}
        connectionError={enabled || unsupported ? props.environment.connectionError : null}
        connectionErrorTraceId={enabled ? props.environment.connectionErrorTraceId : null}
        connectionState={enabled || unsupported ? props.environment.connectionState : "available"}
        errorExpanded={props.errorExpanded}
        label={props.environment.environmentLabel}
        machine={resolveEnvironmentMachineKind(
          serverConfig ?? (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
        )}
        onValueChange={props.onSetEnabled}
        onToggleError={props.onToggleError}
        disabled={unsupported}
        {...(enabled || unsupported ? {} : { statusText: "Off" })}
        value={enabled}
      />
    </Pressable>
  );
}

function CloudEnvironmentRow(props: {
  readonly environment: RelayEnvironmentView;
  readonly borderTop: boolean;
  readonly showChevron: boolean;
  readonly errorExpanded: boolean;
  readonly onConnect: () => void;
  readonly onToggleError: () => void;
}) {
  const presentation = availableCloudEnvironmentPresentation({
    isStatusPending: props.environment.availability === "checking",
    status: props.environment.status,
    statusError: props.environment.error,
    statusErrorTraceId: props.environment.traceId,
  });

  return (
    <CloudEnvironmentRowShell
      borderTop={props.borderTop}
      showChevron={props.showChevron}
      connectionError={presentation.connectionError}
      connectionErrorTraceId={presentation.connectionErrorTraceId}
      connectionState={presentation.connectionState}
      errorExpanded={props.errorExpanded}
      label={props.environment.environment.label}
      machine={resolveEnvironmentMachineKind(
        props.environment.status?.descriptor === undefined
          ? null
          : { environment: props.environment.status.descriptor },
      )}
      onValueChange={(enabled) => {
        if (enabled) {
          props.onConnect();
        }
      }}
      onToggleError={props.onToggleError}
      disabled={presentation.connectionState === "unsupported"}
      statusText={presentation.statusText}
      value={false}
    />
  );
}

function CloudEnvironmentRowShell(props: {
  readonly borderTop: boolean;
  readonly showChevron?: boolean;
  readonly opensDetails?: boolean;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly disabled?: boolean;
  readonly errorExpanded: boolean;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly onToggleError: () => void;
  readonly onValueChange: (enabled: boolean) => void;
  readonly statusText?: string;
  readonly value: boolean;
}) {
  const isRetrying =
    props.connectionState === "connecting" || props.connectionState === "reconnecting";
  const shouldPulse = isRetrying;
  const statusText =
    props.statusText ??
    connectionStatusText({
      phase: props.connectionState,
      error: props.connectionError,
      traceId: props.connectionErrorTraceId,
    });
  // Unsupported is a compatibility note, not a failure, so it stays muted.
  const statusClassName =
    props.connectionError && props.connectionState !== "unsupported"
      ? "text-danger-foreground"
      : "text-foreground-muted";
  const [errorMeasurement, setErrorMeasurement] = useState<{
    readonly text: string;
    readonly lineCount: number;
  } | null>(null);
  const errorTraceId = props.connectionErrorTraceId;
  const measuredErrorText = errorTraceId ? `${statusText} Trace ID: ${errorTraceId}` : statusText;
  const errorLineCount =
    errorMeasurement?.text === measuredErrorText ? errorMeasurement.lineCount : 0;
  const errorCanExpand = props.connectionError !== null && errorLineCount > 1;
  const isErrorExpanded = errorCanExpand && props.errorExpanded;
  const StatusContainer = errorCanExpand ? Pressable : View;
  const onMeasuredErrorTextLayout = useCallback(
    (event: TextLayoutEvent) => {
      if (!props.connectionError) {
        return;
      }
      const nextLineCount = event.nativeEvent.lines.length;
      setErrorMeasurement((currentMeasurement) =>
        currentMeasurement?.text === measuredErrorText &&
        currentMeasurement.lineCount === nextLineCount
          ? currentMeasurement
          : { text: measuredErrorText, lineCount: nextLineCount },
      );
    },
    [measuredErrorText, props.connectionError],
  );
  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3.5",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-center gap-2">
          <ConnectionStatusDot state={props.connectionState} pulse={shouldPulse} size={7} />
          <EnvironmentMachineSymbol
            kind={props.machine}
            size={14}
            tintColorClassName="accent-foreground-muted"
          />
          <Text
            className="min-w-0 flex-shrink text-base font-lecturn-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {props.label}
          </Text>
        </View>
        {props.connectionError ? (
          <Text
            aria-hidden
            onTextLayout={onMeasuredErrorTextLayout}
            className={cn("absolute inset-x-0 -z-[1] text-xs opacity-0", statusClassName)}
          >
            {measuredErrorText}
          </Text>
        ) : null}
        <StatusContainer
          {...(errorCanExpand
            ? { accessibilityRole: "button" as const, onPress: props.onToggleError }
            : {})}
          className="min-w-0 flex-row items-start gap-1"
        >
          <Text
            className={cn("min-w-0 flex-1 text-xs", statusClassName)}
            numberOfLines={isErrorExpanded ? undefined : 1}
          >
            {statusText}
            {errorTraceId ? (
              <ConnectionTraceId
                traceId={errorTraceId}
                tone={
                  props.connectionError && props.connectionState !== "unsupported"
                    ? "danger"
                    : "muted"
                }
                activation="longPress"
              />
            ) : null}
          </Text>
          {errorCanExpand ? (
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName={"accent-chevron"}
              type="monochrome"
              style={{
                marginTop: 3,
                transform: [{ rotate: isErrorExpanded ? "180deg" : "0deg" }],
              }}
            />
          ) : null}
        </StatusContainer>
      </View>
      <ThemedSwitch
        style={{ alignSelf: "center" }}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
      {props.opensDetails || props.showChevron ? (
        <View style={{ opacity: props.opensDetails ? 1 : 0.4 }}>
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
        </View>
      ) : null}
    </View>
  );
}

function CopyTraceIdButton(props: { readonly traceId: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        copyTextWithHaptic(props.traceId, { target: "connection-trace-id" });
      }}
      className="self-start flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-2 active:opacity-70"
    >
      <SymbolView
        name="doc.on.doc"
        size={12}
        tintColorClassName={"accent-icon"}
        type="monochrome"
      />
      <Text className="text-xs font-lecturn-bold text-foreground">Copy trace ID</Text>
    </Pressable>
  );
}
