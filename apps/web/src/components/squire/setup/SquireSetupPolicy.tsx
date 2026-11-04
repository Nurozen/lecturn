import { useAtomValue } from "@effect/atom-react";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import {
  SQUIRE_UNDO_WINDOW_MAX_SECONDS,
  SquireSweepSettings,
  type EnvironmentId,
  type SquireId,
  type SquirePermissionLevel,
  type SquirePermissions,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";

import { useThreadShell } from "../../../state/entities";
import { squireEnvironment } from "../../../state/squires";
import { Alert, AlertDescription } from "../../ui/alert";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { SQUIRE_DEFAULT_DIGEST, SQUIRE_MIN_SWEEP_INTERVAL_HOURS } from "./squireSetup.logic";
import type { SetupFieldsProps } from "./SquireSetupBasics";
import { SquireSweepAcceptance } from "./SquireLeadSweep";
import {
  SetupNumber,
  SetupRow,
  SetupSection,
  SetupSegmented,
  setupOptions,
} from "./SquireSetupLayout";

const LEVELS = setupOptions<SquirePermissionLevel>(["off", "recommend", "auto"]);
const DEFAULT_SWEEP = Schema.decodeSync(SquireSweepSettings)({});

export function SquireEventsSection(props: SetupFieldsProps) {
  const { draft, update, disabled } = props;
  const toggle =
    (key: "turnFinished" | "threadStopped" | "waitingOnUser" | "pullRequestChanged") =>
    (checked: boolean) =>
      update({ events: { ...draft.events, [key]: checked } });
  const rows = [
    ["turnFinished", "A turn finishes"],
    ["threadStopped", "A thread stops or fails"],
    ["waitingOnUser", "A thread waits on you"],
    ["pullRequestChanged", "A pull request changes"],
  ] as const;
  return (
    <SetupSection title="Wakes on">
      {rows.map(([key, label]) => (
        <SetupRow key={key} label={label}>
          <Switch
            aria-label={label}
            checked={draft.events[key]}
            disabled={disabled}
            onCheckedChange={toggle(key)}
          />
        </SetupRow>
      ))}
      <SetupRow label="Waiting counts after" description="Before a waiting thread wakes it.">
        <SetupNumber
          label="Waiting threshold"
          value={draft.events.waitingThresholdMinutes}
          min={1}
          max={24 * 60}
          unit="min"
          disabled={disabled || !draft.events.waitingOnUser}
          onChange={(minutes) =>
            update({ events: { ...draft.events, waitingThresholdMinutes: minutes } })
          }
        />
      </SetupRow>
    </SetupSection>
  );
}

export function SquirePermissionsSection(
  props: SetupFieldsProps & {
    readonly environmentId: EnvironmentId;
    readonly isLead: boolean;
    readonly entry: SquireSnapshotEntry | null;
  },
) {
  const { draft, update, disabled, isLead, entry } = props;
  const set = (patch: Partial<SquirePermissions>) =>
    update({ permissions: { ...draft.permissions, ...patch } });
  const conflicts = entry?.conflicts ?? [];
  return (
    <SetupSection
      title="Permissions"
      description="Recommend asks you first. Auto acts, with the undo window to stop it."
    >
      <SetupRow label="Steer threads">
        <SetupSegmented
          label="Steer threads"
          value={draft.permissions.steer}
          options={LEVELS}
          disabled={disabled}
          onChange={(steer) => set({ steer })}
        />
      </SetupRow>
      {draft.permissions.steer === "auto" && conflicts.length > 0 ? (
        <SteerConflicts
          environmentId={props.environmentId}
          name={draft.name.trim() || "This Squire"}
          conflicts={conflicts}
        />
      ) : null}
      <SetupRow label="Create threads">
        <SetupSegmented
          label="Create threads"
          value={draft.permissions.createThread}
          options={LEVELS}
          disabled={disabled}
          onChange={(createThread) => set({ createThread })}
        />
      </SetupRow>
      {isLead ? (
        <SetupRow label="Manage Squires" description="Pause, resume, rescope, forward, and merge.">
          <SetupSegmented
            label="Manage Squires"
            value={draft.permissions.manageSquires ?? "recommend"}
            options={LEVELS}
            disabled={disabled}
            onChange={(manageSquires) => set({ manageSquires })}
          />
        </SetupRow>
      ) : null}
      <SetupRow label="Notify me">
        <Switch
          aria-label="Notify me"
          checked={draft.permissions.notify === "on"}
          disabled={disabled}
          onCheckedChange={(checked) => set({ notify: checked ? "on" : "off" })}
        />
      </SetupRow>
    </SetupSection>
  );
}

/** One Squire holds steer Auto per thread; the earliest-created one keeps it. */
function SteerConflicts(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly conflicts: SquireSnapshotEntry["conflicts"];
}) {
  return (
    <Alert variant="warning">
      <AlertDescription>
        <p>
          {props.name} stays Recommend on{" "}
          {props.conflicts.length === 1 ? "this thread" : "these threads"}, where another Squire
          already holds Auto:
        </p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {props.conflicts.map((conflict) => (
            <ConflictLine
              key={conflict.threadId}
              environmentId={props.environmentId}
              threadId={conflict.threadId}
              holderId={conflict.autoHolderSquireId}
            />
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ConflictLine(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly holderId: SquireId;
}) {
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  const holder = useAtomValue(squireEnvironment.entry(props.environmentId, props.holderId));
  return (
    <li className="truncate">
      {shell?.title ?? "A thread"} · {holder?.squire.name ?? "another Squire"} holds Auto
    </li>
  );
}

export function SquireBudgetsSection(
  props: SetupFieldsProps & { readonly entry: SquireSnapshotEntry | null },
) {
  const { draft, update, disabled, entry } = props;
  const set = (patch: Partial<SetupFieldsProps["draft"]["budgets"]>) =>
    update({ budgets: { ...draft.budgets, ...patch } });
  const left = (count: number | undefined) =>
    count === undefined ? undefined : `${count} left today`;
  return (
    <SetupSection
      title="Budgets"
      description={
        entry?.budget.recommendingUntil === undefined
          ? "Past a budget it recommends instead of acting."
          : "Budget reached: recommending only for now."
      }
    >
      <SetupRow label="Steers a day" description={left(entry?.budget.steersLeft)}>
        <SetupNumber
          label="Steers a day"
          value={draft.budgets.steersPerDay}
          min={0}
          max={500}
          disabled={disabled}
          onChange={(steersPerDay) => set({ steersPerDay })}
        />
      </SetupRow>
      <SetupRow label="Steers per thread an hour">
        <SetupNumber
          label="Steers per thread an hour"
          value={draft.budgets.steersPerThreadPerHour}
          min={0}
          max={60}
          disabled={disabled}
          onChange={(steersPerThreadPerHour) => set({ steersPerThreadPerHour })}
        />
      </SetupRow>
      <SetupRow label="New threads a day" description={left(entry?.budget.threadsLeft)}>
        <SetupNumber
          label="New threads a day"
          value={draft.budgets.threadsPerDay}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(threadsPerDay) => set({ threadsPerDay })}
        />
      </SetupRow>
      <SetupRow label="Messages a day" description="To other Squires and rooms.">
        <SetupNumber
          label="Messages a day"
          value={draft.budgets.messagesPerDay}
          min={0}
          max={500}
          disabled={disabled}
          onChange={(messagesPerDay) => set({ messagesPerDay })}
        />
      </SetupRow>
      <SetupRow label="Undo window" description="How long an Auto action waits before it runs.">
        <SetupNumber
          label="Undo window"
          value={draft.undoWindowSeconds}
          min={0}
          max={SQUIRE_UNDO_WINDOW_MAX_SECONDS}
          unit="s"
          disabled={disabled}
          onChange={(undoWindowSeconds) => update({ undoWindowSeconds })}
        />
      </SetupRow>
    </SetupSection>
  );
}

export function SquireDigestSection(props: SetupFieldsProps) {
  const { draft, update, disabled } = props;
  const digest = draft.digest;
  return (
    <SetupSection title="Daily digest" description="What moved, what is blocked, and what waits.">
      <SetupRow label="Send a digest">
        <Switch
          aria-label="Send a digest"
          checked={digest !== null}
          disabled={disabled}
          onCheckedChange={(checked) => update({ digest: checked ? SQUIRE_DEFAULT_DIGEST : null })}
        />
      </SetupRow>
      {digest === null ? null : (
        <>
          <SetupRow label="At">
            <Input
              type="time"
              aria-label="Digest time"
              size="sm"
              className="w-28"
              value={digest.time}
              disabled={disabled}
              onChange={(event) => {
                if (/^\d{2}:\d{2}$/.test(event.target.value)) {
                  update({ digest: { ...digest, time: event.target.value } });
                }
              }}
            />
          </SetupRow>
          <SetupRow label="Push to my phone">
            <Switch
              aria-label="Push the digest"
              checked={digest.push}
              disabled={disabled}
              onCheckedChange={(push) => update({ digest: { ...digest, push } })}
            />
          </SetupRow>
        </>
      )}
    </SetupSection>
  );
}

type SweepKind = SquireSweepSettings["schedule"]["kind"];
const SWEEP_KINDS: ReadonlyArray<{ readonly value: SweepKind; readonly label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "interval", label: "Every few hours" },
];

/** The Lead's find-work sweep. */
export function SquireSweepSection(
  props: SetupFieldsProps & { readonly environmentId: EnvironmentId; readonly leadId: SquireId },
) {
  const { draft, update, disabled } = props;
  const sweep = draft.sweep ?? DEFAULT_SWEEP;
  const set = (patch: Partial<SquireSweepSettings>) => update({ sweep: { ...sweep, ...patch } });
  const { schedule } = sweep;
  return (
    <SetupSection
      title="Sweep"
      description="Looks for idle pull requests and failing checks nobody is working on."
    >
      <SetupRow label="Runs">
        <SetupSegmented
          label="Sweep schedule"
          value={schedule.kind}
          options={SWEEP_KINDS}
          disabled={disabled}
          onChange={(kind) =>
            set({
              schedule:
                kind === "interval"
                  ? { kind, hours: Math.max(SQUIRE_MIN_SWEEP_INTERVAL_HOURS, 6) }
                  : { kind },
            })
          }
        />
      </SetupRow>
      {schedule.kind === "interval" ? (
        <SetupRow label="Every">
          <SetupNumber
            label="Sweep interval"
            value={schedule.hours}
            min={SQUIRE_MIN_SWEEP_INTERVAL_HOURS}
            max={24}
            unit="h"
            disabled={disabled}
            onChange={(hours) => set({ schedule: { kind: "interval", hours } })}
          />
        </SetupRow>
      ) : null}
      {schedule.kind === "off" ? null : (
        <>
          <SetupRow label="Sweeps a day">
            <SetupNumber
              label="Sweeps a day"
              value={sweep.sweepsPerDay}
              min={0}
              max={24}
              disabled={disabled}
              onChange={(sweepsPerDay) => set({ sweepsPerDay })}
            />
          </SetupRow>
          <SetupRow label="Findings a sweep">
            <SetupNumber
              label="Findings a sweep"
              value={sweep.findingsPerSweep}
              min={0}
              max={20}
              disabled={disabled}
              onChange={(findingsPerSweep) => set({ findingsPerSweep })}
            />
          </SetupRow>
          <SetupRow label="Findings a day">
            <SetupNumber
              label="Findings a day"
              value={sweep.findingsPerDay}
              min={0}
              max={50}
              disabled={disabled}
              onChange={(findingsPerDay) => set({ findingsPerDay })}
            />
          </SetupRow>
        </>
      )}
      <SquireSweepAcceptance environmentId={props.environmentId} leadId={props.leadId} />
    </SetupSection>
  );
}
