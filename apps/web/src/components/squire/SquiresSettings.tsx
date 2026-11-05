import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import {
  squireStateLine,
  type SquireEnvironmentState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type SquireEnvironmentSettings,
  type SquireId,
  type UnifiedSettings,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { Suspense, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentIdentities } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { squireCapableAtom, squireEnvironment, useSquireEnvironments } from "../../state/squires";
import { useAtomCommand } from "../../state/use-atom-command";
import { LazyExtensionsFunding } from "../DecisionsFunding";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SquirePortrait, useSquireIndicator } from "./SquireHeader";
import { releaseSquireKnock } from "./SquireKnock";
import { squireSwitchDescription } from "./squirePage.logic";
import { openSquireSetup } from "./setup/squireSetupStore";
import { SquireAutomationPausedNotice } from "./setup/SquireTriggersSection";

const PHONE_ALERT_LABELS: Record<SquireEnvironmentSettings["phoneAlertsWhileDesktop"], string> = {
  "after-3-min": "After 3 minutes",
  immediately: "Immediately",
  never: "Never",
};

const selectSquireSettings = (settings: UnifiedSettings) => settings.squire;

/**
 * Settings > Squires: the switch that turns Squires on for an environment, then that
 * environment's Squires and shared settings once its server runs them.
 */
export function SquiresSettings(props: {
  readonly squire?: SquireId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}) {
  const environments = useSquireEnvironments();
  const identities = useEnvironmentIdentities();
  // An explicit pick wins; a Squire link lands on its own environment.
  const selectedId =
    identities.find((identity) => identity.environmentId === props.environmentId)?.environmentId ??
    (props.squire === undefined
      ? undefined
      : environments.find((environment) =>
          environment.state.squires.some((entry) => entry.squire.id === props.squire),
        )?.environmentId) ??
    environments[0]?.environmentId ??
    identities[0]?.environmentId;
  if (selectedId === undefined) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Squires">
          <SettingsRow
            title="No environment connected"
            description="Connect an environment to turn on Squires there."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  const selected = environments.find((environment) => environment.environmentId === selectedId);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Squires">
        {identities.length > 1 ? (
          <SettingsRow
            title="Environment"
            description="Each environment has its own Lead, Squires, and settings."
            control={
              <Select
                value={selectedId}
                onValueChange={(value) => {
                  const next = identities.find((identity) => identity.environmentId === value);
                  if (next !== undefined) props.onEnvironmentChange?.(next.environmentId);
                }}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {identities.find((identity) => identity.environmentId === selectedId)?.label ??
                      selectedId}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {identities.map(({ environmentId, label }) => (
                    <SelectItem key={environmentId} value={environmentId}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SquireEnabledRow environmentId={selectedId} />
        <SquireKnockResetRow environmentId={selectedId} />
      </SettingsSection>
      {selected === undefined ? null : (
        <>
          <SquireAutomationPausedNotice environmentId={selected.environmentId} />
          <SquireEnvironmentSection
            key={selected.environmentId}
            environmentId={selected.environmentId}
            state={selected.state}
            highlighted={props.squire ?? null}
          />
          <SquireEnvironmentSettingsSection environmentId={selected.environmentId} />
        </>
      )}
    </SettingsPageContainer>
  );
}

/**
 * The saved `squire.enabled` switch. A server with `squireLiveSwitch` applies it at once; older
 * ones on their next start.
 */
function SquireEnabledRow(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const running = useAtomValue(squireCapableAtom(environmentId));
  const live =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .squireLiveSwitch === true;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const saved = settings?.squire.enabled;
  return (
    <SettingsRow
      {...searchableSetting("squires-enabled")}
      description={
        saved === undefined
          ? "Loading this environment's settings."
          : squireSwitchDescription({ saved, running, live })
      }
      control={
        <Switch
          checked={saved ?? running}
          disabled={!canWrite || saved === undefined}
          aria-label="Enable Squires"
          onCheckedChange={(checked) => updateSettings({ squire: { enabled: Boolean(checked) } })}
        />
      }
    />
  );
}

/**
 * The way back from the suggestion's "Not now" and "Don't show again", while it could still
 * show: Squires off on a server that turns them on live.
 */
function SquireKnockResetRow(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const knock = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.squire.knock;
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  if (
    knock === undefined ||
    (!knock.dismissed && knock.snoozedUntil === "") ||
    capabilities?.squireLiveSwitch !== true ||
    capabilities.squire === true
  ) {
    return null;
  }
  return (
    <SettingsRow
      title="Squire suggestion"
      description="Hidden. While Squires are off, a Squire offers to help when two or more threads run at once."
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite}
          onClick={() => {
            releaseSquireKnock(environmentId);
            updateSettings({ squire: { knock: { dismissed: false, snoozedUntil: "" } } });
          }}
        >
          Show again
        </Button>
      }
    />
  );
}

function SquireEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly state: SquireEnvironmentState;
  readonly highlighted: SquireId | null;
}) {
  const { environmentId } = props;
  const canCreate = useAtomValue(squireEnvironment.create.permissionAtom(environmentId));
  // The Lead first, as in the sidebar group.
  const squires = props.state.squires.toSorted(
    (a, b) => Number(b.squire.role === "lead") - Number(a.squire.role === "lead"),
  );
  return (
    <SettingsSection
      title="Squires"
      headerAction={
        canCreate ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openSquireSetup({ kind: "create", environmentId })}
          >
            <PlusIcon />
            New Squire
          </Button>
        ) : null
      }
    >
      {squires.length === 0 ? (
        <SettingsRow title="No Lead yet" />
      ) : (
        squires.map((entry) => (
          <SquireSettingsRow
            key={entry.squire.id}
            environmentId={environmentId}
            entry={entry}
            highlighted={props.highlighted === entry.squire.id}
          />
        ))
      )}
    </SettingsSection>
  );
}

function SquireSettingsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly highlighted: boolean;
}) {
  const { environmentId, entry } = props;
  const navigate = useNavigate();
  const indicator = useSquireIndicator(environmentId, entry);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canSetStatus = useAtomValue(squireEnvironment.setStatus.permissionAtom(environmentId));
  const canEdit = useAtomValue(squireEnvironment.update.permissionAtom(environmentId));
  const canDelete = useAtomValue(squireEnvironment.delete.permissionAtom(environmentId));
  const setStatus = useAtomCommand(squireEnvironment.setStatus);
  const deleteSquire = useAtomCommand(squireEnvironment.delete);
  const [pending, setPending] = useState(false);
  const { squire } = entry;
  const isLead = squire.role === "lead";
  const provider =
    squire.providerInstanceId === null
      ? null
      : (config?.providers.find(
          (candidate) => candidate.instanceId === squire.providerInstanceId,
        ) ?? null);
  const providerLabel =
    squire.providerInstanceId === null
      ? "No provider"
      : provider === null
        ? squire.providerInstanceId
        : resolveProviderInstanceDisplayName(provider);
  const paused = squire.status === "paused";
  const toggleStatus = async () => {
    setPending(true);
    await setStatus({
      environmentId,
      input: { requestId: randomUUID(), squireId: squire.id, status: paused ? "active" : "paused" },
    });
    setPending(false);
  };
  // No restore: the Squire's record, rules, and triggers are gone, and its home thread is archived.
  const remove = async () => {
    const message = [
      `Delete ${squire.name}?`,
      "This permanently deletes the Squire with its rules and triggers, and archives its home thread. The threads it watches are kept.",
    ].join("\n");
    const localApi = readLocalApi();
    const confirmed =
      localApi === undefined
        ? window.confirm(message)
        : await localApi.dialogs.confirm(message, { variant: "destructive" });
    if (!confirmed) return;
    setPending(true);
    await deleteSquire({
      environmentId,
      input: { requestId: randomUUID(), squireId: squire.id },
    });
    setPending(false);
  };
  return (
    <SettingsRow
      // Arriving from a Squire view's gear marks that Squire's row.
      aria-current={props.highlighted ? "true" : undefined}
      className={props.highlighted ? "bg-accent/60" : undefined}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <SquirePortrait
            environmentId={environmentId}
            entry={entry}
            size={28}
            label={squire.name}
          />
          <span className="truncate">{squire.name}</span>
        </span>
      }
      description={`${squireStateLine({
        squire,
        indicator,
        openDecisionCount: entry.openDecisionCount,
        heldCount: entry.held.length,
      })} · ${providerLabel}`}
      control={
        <>
          {/* Edit is the row's main action; pausing is occasional, so it stays plain. */}
          <Button
            size="xs"
            variant="default"
            disabled={!canEdit}
            onClick={() => openSquireSetup({ kind: "edit", environmentId, squireId: squire.id })}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/squires/$environmentId/$squireId",
                params: { environmentId, squireId: squire.id },
              })
            }
          >
            Open
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!canSetStatus || pending || squire.lifecycle === "needs_provider"}
            onClick={() => void toggleStatus()}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          {/* The server refuses to delete the Lead. */}
          {isLead || !canDelete ? null : (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          )}
        </>
      }
    />
  );
}

/** Environment-wide Squire settings, the `squire` block of the server settings. */
function SquireEnvironmentSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const settings = useEnvironmentSettings(environmentId, selectSquireSettings);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const defaults = DEFAULT_SERVER_SETTINGS.squire;
  const update = (patch: Partial<SquireEnvironmentSettings>) => updateSettings({ squire: patch });
  return (
    <SettingsSection title="Squire settings">
      <SettingsRow
        {...searchableSetting("squires-phone-alerts")}
        description="When a Squire needs you while this environment sees you at a desktop, how long to wait before your phone is alerted too."
        control={
          <Select
            value={settings.phoneAlertsWhileDesktop}
            disabled={!canWrite}
            onValueChange={(value) => {
              if (value === "after-3-min" || value === "immediately" || value === "never") {
                update({ phoneAlertsWhileDesktop: value });
              }
            }}
          >
            <SelectTrigger size="sm">
              <SelectValue>{PHONE_ALERT_LABELS[settings.phoneAlertsWhileDesktop]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(PHONE_ALERT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("squires-inactivity")}
        description={`After this many days without you acting in Squires, the Lead asks whether to keep triggers and the sweep running. Default ${defaults.inactivityDays}.`}
        control={
          <DayHourField
            label="Days"
            value={settings.inactivityDays}
            min={1}
            max={30}
            disabled={!canWrite}
            onCommit={(inactivityDays) => update({ inactivityDays })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("squires-bot-messages")}
        description="Let Squires and the Lead message each other and post in rooms. Your own posts are never blocked."
        control={
          <Switch
            checked={settings.botMessages}
            disabled={!canWrite}
            aria-label="Squire-to-Squire messages"
            onCheckedChange={(checked) => update({ botMessages: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("squires-room-ttl")}
        description={`New rooms close after this many idle hours unless set otherwise. Default ${defaults.roomIdleTtlHours}.`}
        control={
          <DayHourField
            label="Hours"
            value={settings.roomIdleTtlHours}
            min={1}
            max={168}
            disabled={!canWrite}
            onCommit={(roomIdleTtlHours) => update({ roomIdleTtlHours })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("squires-room-routing")}
        description="Rooms route each post to the Squire it is for. Without Jev funding, routing uses mentions and rules only."
      >
        <div className="pb-3">
          <Suspense fallback={null}>
            <LazyExtensionsFunding environmentId={environmentId} featureId="squires" />
          </Suspense>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function DayHourField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <NumberField
      value={props.value}
      min={props.min}
      max={props.max}
      step={1}
      disabled={props.disabled}
      size="sm"
      className="w-20"
      onValueCommitted={(value) => {
        if (value === null) return;
        const next = Math.round(value);
        if (next >= props.min && next <= props.max && next !== props.value) props.onCommit(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldInput aria-label={props.label} />
      </NumberFieldGroup>
    </NumberField>
  );
}
