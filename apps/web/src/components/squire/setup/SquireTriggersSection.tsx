import { useAtomValue } from "@effect/atom-react";
import { webhookAddress } from "@lecturn/client-runtime/webhook-address";
import type { EnvironmentId, Squire, SquireTrigger } from "@lecturn/contracts";
import { ChevronRightIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useReducer, useState } from "react";

import { requestConfirmDialog } from "../../../confirmDialog";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useClientSettings } from "../../../hooks/useSettings";
import { randomUUID } from "../../../lib/utils";
import { useEnvironmentHttpBaseUrl } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatDayAwareTimestamp, resolveHour12 } from "../../../timestampFormat";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Textarea } from "../../ui/textarea";
import {
  EMPTY_SQUIRE_TRIGGER_DRAFT,
  squireCanAddTrigger,
  squireSecretRevealReducer,
  squireTriggerControls,
  squireTriggerDraftInput,
  squireTriggerLimitText,
  squireTriggerRunLabel,
  squireTriggerSentence,
  squireTriggerTestText,
  squireWebhookPath,
  type SquireSecretReveal,
  type SquireSecretRevealAction,
  type SquireTriggerDraft,
} from "./squireSetupAutomation.logic";

// Labels for the trigger value too, or the closed Select shows the raw "webhook".
const TRIGGER_KIND_ITEMS = [
  { value: "schedule", label: "Schedule" },
  { value: "webhook", label: "Custom webhook" },
] as const;
const SCHEDULE_KIND_ITEMS = [
  { value: "daily", label: "At a time of day" },
  { value: "interval", label: "Every few hours" },
] as const;

type RevealDispatch = (action: SquireSecretRevealAction) => void;

function useTriggerTimeFormat() {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return {
    hour12: resolveHour12(timestampFormat),
    formatTime: (iso: string) => formatDayAwareTimestamp(iso, timestampFormat),
  };
}

/** P3.6 triggers as intent sentences (plan 10b.6). Never rendered for the Lead. */
export function SquireTriggersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly squire: Pick<Squire, "id" | "name" | "role">;
}) {
  const { environmentId, squire } = props;
  const isLead = squire.role === "lead";
  const triggers = useEnvironmentQuery(
    isLead ? null : squireEnvironment.triggers({ environmentId, input: { squireId: squire.id } }),
  );
  const canCreate = useAtomValue(squireEnvironment.triggerCreate.permissionAtom(environmentId));
  // The secret exists only here, and only while its dialog is open (OQ27).
  const [reveal, dispatchReveal] = useReducer(squireSecretRevealReducer, null);
  if (isLead) return null;
  const list = triggers.data?.triggers ?? null;
  return (
    <div className="flex flex-col gap-3">
      <SquireAutomationPausedNotice environmentId={environmentId} />
      {list === null ? (
        triggers.error !== null ? (
          <p className="text-xs text-muted-foreground">Triggers could not be loaded.</p>
        ) : (
          <Spinner />
        )
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No triggers. Add a schedule to wake {squire.name} without a thread event.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {list.map((trigger) => (
            <SquireTriggerRow
              key={trigger.id}
              environmentId={environmentId}
              trigger={trigger}
              onReveal={dispatchReveal}
            />
          ))}
        </ul>
      )}
      {list !== null && canCreate && squireCanAddTrigger(squire.role, list) ? (
        <SquireAddTrigger
          environmentId={environmentId}
          squireId={squire.id}
          onReveal={dispatchReveal}
        />
      ) : null}
      <SquireSecretDialog
        environmentId={environmentId}
        reveal={reveal}
        onClose={() => dispatchReveal({ type: "closed" })}
      />
    </div>
  );
}

/** P3.6 inactivity pause: every trigger and the sweep stopped until the user resumes them. */
export function SquireAutomationPausedNotice(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const state = useSquireEnvironmentState(environmentId);
  const canResume = useAtomValue(squireEnvironment.automationResume.permissionAtom(environmentId));
  const resume = useAtomCommand(squireEnvironment.automationResume);
  const [pending, setPending] = useState(false);
  const lead = state?.squires.find((entry) => entry.squire.role === "lead")?.squire ?? null;
  if (lead?.automationPausedAt == null) return null;
  const resumeAll = async () => {
    setPending(true);
    await resume({ environmentId, input: { requestId: randomUUID() } });
    setPending(false);
  };
  return (
    <Alert variant="warning">
      <AlertTitle>Triggers and the sweep are paused</AlertTitle>
      <AlertDescription>
        Nobody acted in Squires for a while, so scheduled and webhook wakes stopped. Thread events
        still reach your Squires.
      </AlertDescription>
      <AlertAction>
        <Button
          size="xs"
          variant="outline"
          disabled={!canResume || pending}
          onClick={() => void resumeAll()}
        >
          Resume all
        </Button>
      </AlertAction>
    </Alert>
  );
}

function SquireTriggerRow(props: {
  readonly environmentId: EnvironmentId;
  readonly trigger: SquireTrigger;
  readonly onReveal: RevealDispatch;
}) {
  const { environmentId, trigger } = props;
  const { hour12, formatTime } = useTriggerTimeFormat();
  const canUpdate = useAtomValue(squireEnvironment.triggerUpdate.permissionAtom(environmentId));
  const canTest = useAtomValue(squireEnvironment.triggerTest.permissionAtom(environmentId));
  const update = useAtomCommand(squireEnvironment.triggerUpdate);
  const test = useAtomCommand(squireEnvironment.triggerTest);
  // Collapsed on every mount, a just-created webhook included (OQ27).
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const controls = squireTriggerControls(trigger, advancedOpen);
  const setStatus = async (status: "active" | "paused") => {
    setPending(true);
    await update({
      environmentId,
      input: { requestId: randomUUID(), triggerId: trigger.id, status },
    });
    setPending(false);
  };
  const testNow = async (samplePayload?: string) => {
    setPending(true);
    const result = await test({
      environmentId,
      input: {
        requestId: randomUUID(),
        triggerId: trigger.id,
        ...(samplePayload === undefined || samplePayload.trim() === "" ? {} : { samplePayload }),
      },
    });
    setPending(false);
    if (result._tag === "Success") setNotice(squireTriggerTestText(result.value, formatTime));
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm">{squireTriggerSentence(trigger, hour12)}</p>
          <p className="text-xs text-muted-foreground">{trigger.instruction}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge
              variant={
                trigger.status === "active"
                  ? "success"
                  : trigger.status === "paused"
                    ? "warning"
                    : "outline"
              }
            >
              {trigger.status === "active"
                ? "Active"
                : trigger.status === "paused"
                  ? "Paused"
                  : "Revoked"}
            </Badge>
            {trigger.limitedUntil !== null && trigger.status !== "revoked" ? (
              <TriggerLimit key={trigger.limitedUntil} trigger={trigger} formatTime={formatTime} />
            ) : null}
            {notice !== null ? <span role="status">{notice}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {controls.includes("test") && trigger.kind === "schedule" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canTest || pending}
              onClick={() => void testNow()}
            >
              Test now
            </Button>
          ) : null}
          {controls.includes("pause") || controls.includes("resume") ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canUpdate || pending}
              onClick={() => void setStatus(controls.includes("pause") ? "paused" : "active")}
            >
              {controls.includes("pause") ? "Pause" : "Resume"}
            </Button>
          ) : null}
        </div>
      </div>
      <Collapsible open={runsOpen} onOpenChange={setRunsOpen}>
        <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
          <ChevronRightIcon className={runsOpen ? "rotate-90" : undefined} />
          Recent runs
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {/* Mounted only while open, so the history is fetched only while it is read. */}
          {runsOpen ? (
            <SquireTriggerRuns
              environmentId={environmentId}
              trigger={trigger}
              formatTime={formatTime}
            />
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      {controls.includes("advanced") ? (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
            <ChevronRightIcon className={advancedOpen ? "rotate-90" : undefined} />
            Advanced: custom webhook
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {advancedOpen ? (
              <SquireWebhookAdvanced
                environmentId={environmentId}
                trigger={trigger}
                pending={pending}
                canTest={canTest}
                onTest={(sample) => void testNow(sample)}
                onReveal={props.onReveal}
              />
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </li>
  );
}

function TriggerLimit(props: {
  readonly trigger: SquireTrigger;
  readonly formatTime: (iso: string) => string;
}) {
  // The server clears an expired limit on the next list; this only hides one that lapsed since.
  const [nowMs] = useState(() => Date.now());
  const text = squireTriggerLimitText(props.trigger, nowMs, props.formatTime);
  return text === null ? null : <Badge variant="warning">{text}</Badge>;
}

function SquireTriggerRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly trigger: SquireTrigger;
  readonly formatTime: (iso: string) => string;
}) {
  const runs = useEnvironmentQuery(
    squireEnvironment.triggerRuns({
      environmentId: props.environmentId,
      input: { triggerId: props.trigger.id },
    }),
  );
  if (runs.data === null) {
    return runs.error !== null ? (
      <p className="px-2 py-1 text-xs text-muted-foreground">Runs could not be loaded.</p>
    ) : (
      <Spinner />
    );
  }
  if (runs.data.runs.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No runs yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-0.5 px-2 py-1 text-xs text-muted-foreground tabular-nums">
      {runs.data.runs.map((run) => (
        <li key={`${run.at}:${run.origin}:${run.outcome}`}>
          {squireTriggerRunLabel(run, props.formatTime)}
        </li>
      ))}
    </ol>
  );
}

function SquireWebhookAdvanced(props: {
  readonly environmentId: EnvironmentId;
  readonly trigger: SquireTrigger;
  readonly pending: boolean;
  readonly canTest: boolean;
  readonly onTest: (samplePayload: string) => void;
  readonly onReveal: RevealDispatch;
}) {
  const { environmentId, trigger } = props;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const canRotate = useAtomValue(squireEnvironment.triggerRotate.permissionAtom(environmentId));
  const canRevoke = useAtomValue(squireEnvironment.triggerRevoke.permissionAtom(environmentId));
  const rotate = useAtomCommand(squireEnvironment.triggerRotate);
  const revoke = useAtomCommand(squireEnvironment.triggerRevoke);
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState(false);
  const address = webhookAddress(
    { path: squireWebhookPath(trigger.id), url: null, hasSecret: true },
    httpBaseUrl,
  );
  const confirm = async (message: string) =>
    (await requestConfirmDialog(message, { variant: "destructive" })) ??
    window.confirm(message.replace("\n", " "));
  const rotateSecret = async () => {
    if (!(await confirm("Rotate this webhook's secret?\nThe current secret stops working."))) {
      return;
    }
    setBusy(true);
    const result = await rotate({
      environmentId,
      input: { requestId: randomUUID(), triggerId: trigger.id },
    });
    setBusy(false);
    if (result._tag === "Success") {
      props.onReveal({
        type: "rotated",
        trigger: result.value.trigger,
        webhook: result.value.webhook,
      });
    }
  };
  const revokeTrigger = async () => {
    if (!(await confirm("Revoke this webhook?\nIts URL stops accepting requests for good."))) {
      return;
    }
    setBusy(true);
    await revoke({ environmentId, input: { requestId: randomUUID(), triggerId: trigger.id } });
    setBusy(false);
  };
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border p-2">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          size="sm"
          aria-label="Webhook URL"
          value={address.address}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!address.copyable}
          onClick={() => copyToClipboard(address.address, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      {address.note !== null ? (
        <p className="text-xs text-muted-foreground">{address.note}</p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Secret shown once when created. Send it as <code>Authorization: Bearer</code> or an{" "}
          <code>X-Hub-Signature-256</code> HMAC.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={!canRotate || busy}
            onClick={() => void rotateSecret()}
          >
            Rotate
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={!canRevoke || busy}
            onClick={() => void revokeTrigger()}
          >
            Revoke
          </Button>
        </div>
      </div>
      <Textarea
        size="sm"
        aria-label="Sample payload"
        placeholder="Paste a sample JSON body, or leave empty to reuse the last one received"
        value={sample}
        onChange={(event) => setSample(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canTest || props.pending}
          onClick={() => props.onTest(sample)}
        >
          Test now
        </Button>
      </div>
    </div>
  );
}

function SquireSecretDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly reveal: SquireSecretReveal | null;
  readonly onClose: () => void;
}) {
  const { reveal } = props;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const secretCopy = useCopyToClipboard({ target: "webhook secret" });
  const urlCopy = useCopyToClipboard({ target: "webhook URL" });
  const address =
    reveal === null
      ? null
      : webhookAddress({ path: reveal.webhook.path, url: null, hasSecret: true }, httpBaseUrl);
  return (
    <Dialog
      open={reveal !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {reveal !== null && address !== null ? (
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {reveal.reason === "created" ? "Webhook secret" : "New webhook secret"}
            </DialogTitle>
            <DialogDescription>
              Copy it now. It is shown once and cannot be read again; rotate it if you lose it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <p className="text-sm">{reveal.triggerName}</p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  size="sm"
                  aria-label="Webhook secret"
                  value={reveal.webhook.secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => secretCopy.copyToClipboard(reveal.webhook.secret, undefined)}
                >
                  <CopyIcon />
                  {secretCopy.isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  size="sm"
                  aria-label="Webhook URL"
                  value={address.address}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!address.copyable}
                  onClick={() => urlCopy.copyToClipboard(address.address, undefined)}
                >
                  <CopyIcon />
                  {urlCopy.isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function SquireAddTrigger(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: Squire["id"];
  readonly onReveal: RevealDispatch;
}) {
  const { environmentId } = props;
  const create = useAtomCommand(squireEnvironment.triggerCreate);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SquireTriggerDraft>(EMPTY_SQUIRE_TRIGGER_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (patch: Partial<SquireTriggerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const save = async () => {
    const built = squireTriggerDraftInput(draft, props.squireId);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    const result = await create({
      environmentId,
      input: { ...built.input, requestId: randomUUID() },
    });
    setSaving(false);
    if (result._tag !== "Success") return;
    props.onReveal({
      type: "created",
      trigger: result.value.trigger,
      webhook: result.value.webhook,
    });
    setDraft(EMPTY_SQUIRE_TRIGGER_DRAFT);
    setOpen(false);
  };
  if (!open) {
    return (
      <div>
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          <PlusIcon />
          Add trigger
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-1.5">
        <Label size="sm">Kind</Label>
        <Select
          value={draft.kind}
          items={TRIGGER_KIND_ITEMS}
          onValueChange={(value) => {
            if (value === "schedule" || value === "webhook") edit({ kind: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Trigger kind">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {TRIGGER_KIND_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {draft.kind === "webhook" ? (
        <div className="flex flex-col gap-1.5">
          <Label size="sm">When</Label>
          <Input
            size="sm"
            aria-label="When this webhook fires"
            placeholder="When Sentry reports a new error in billing-service"
            value={draft.name}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label size="sm">Runs</Label>
            <Select
              value={draft.scheduleKind}
              items={SCHEDULE_KIND_ITEMS}
              onValueChange={(value) => {
                if (value === "interval" || value === "daily") edit({ scheduleKind: value });
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SCHEDULE_KIND_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {draft.scheduleKind === "interval" ? (
            <div className="flex flex-col gap-1.5">
              <Label size="sm">Hours</Label>
              <NumberField
                value={draft.hours}
                min={1}
                max={168}
                size="sm"
                className="w-24"
                onValueChange={(value) => edit({ hours: value ?? 1 })}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Hours between runs" />
                </NumberFieldGroup>
              </NumberField>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label size="sm">Time</Label>
                <Input
                  size="sm"
                  type="time"
                  aria-label="Time of day"
                  value={draft.time}
                  onChange={(event) => edit({ time: event.target.value })}
                />
              </div>
              <Label variant="checkbox" size="sm">
                <Checkbox
                  checked={draft.weekdaysOnly}
                  onCheckedChange={(checked) => edit({ weekdaysOnly: checked === true })}
                />
                Weekdays only
              </Label>
            </>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label size="sm">Instruction</Label>
        <Textarea
          size="sm"
          aria-label="Instruction"
          placeholder="Check the release threads for PRs waiting on review"
          value={draft.instruction}
          onChange={(event) => edit({ instruction: event.target.value })}
        />
      </div>
      {error !== null ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setDraft(EMPTY_SQUIRE_TRIGGER_DRAFT);
          }}
        >
          Cancel
        </Button>
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          Add trigger
        </Button>
      </div>
    </div>
  );
}
