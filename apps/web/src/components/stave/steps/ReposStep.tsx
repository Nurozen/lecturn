import { useStaveStatus } from "../../../state/stave";
import { staveOperationUnavailableReason } from "../staveCompatibility.logic";
import type { EnvironmentId, StaveRepoRow } from "@lecturn/contracts";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { staveOperations } from "../../../state/staveOperations";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  buildRegisterRepoOperation,
  EMPTY_REGISTER_REPO_FORM,
  setRepoBase,
  setRepoMode,
  setRepoRef,
  spaceBaseOptions,
  type StaveSpaceWizardState,
  type StaveWizardContext,
  type StaveWizardRepoMode,
  type StaveWizardRepoRow,
  updateWizardState,
  validateRegisterRepoForm,
} from "../staveSpaceWizard.logic";
import { StaveOperationProgress } from "../StaveOperationProgress";

const REPO_MODES: ReadonlyArray<{ value: StaveWizardRepoMode; label: string }> = [
  { value: "none", label: "Skip" },
  { value: "edit", label: "Edit" },
  { value: "reference", label: "Reference" },
];

function isRepoMode(value: unknown): value is StaveWizardRepoMode {
  return REPO_MODES.some((mode) => mode.value === value);
}

function RepoRow(props: {
  readonly row: StaveWizardRepoRow;
  readonly registry: StaveRepoRow | undefined;
  readonly context: StaveWizardContext;
  readonly onMode: (mode: StaveWizardRepoMode) => void;
  readonly onBase: (base: string) => void;
  readonly onRef: (ref: string) => void;
}) {
  const { row, registry, context, onMode, onBase, onRef } = props;
  const baseOptions = row.mode === "edit" ? spaceBaseOptions(context.spaces, row.repo) : [];
  const selectedBase = baseOptions.find((option) => option.value === row.base.trim()) ?? null;
  const defaultBranch = registry?.defaultBranch;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.repo}</p>
          <p className="truncate text-xs text-muted-foreground">
            {defaultBranch === undefined ? "default branch unknown" : `default ${defaultBranch}`}
          </p>
        </div>
        <ToggleGroup
          aria-label={`${row.repo} mode`}
          size="xs"
          variant="outline"
          value={[row.mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (isRepoMode(next)) onMode(next);
          }}
        >
          {REPO_MODES.map((mode) => (
            <Toggle data-lecturn-hover key={mode.value} value={mode.value} className="px-2">
              {mode.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {row.mode === "edit" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="min-w-40 flex-1 font-mono"
            value={row.base}
            placeholder={defaultBranch ?? "default branch"}
            spellCheck={false}
            aria-label={`${row.repo} base`}
            onChange={(event) => onBase(event.target.value)}
          />
          {baseOptions.length > 0 ? (
            <Select
              value={selectedBase?.value ?? null}
              onValueChange={(value) => {
                if (typeof value === "string") onBase(value);
              }}
            >
              <SelectTrigger
                data-lecturn-hover
                size="sm"
                className="w-44"
                aria-label={`Stack ${row.repo} on a space`}
              >
                <SelectValue>{selectedBase?.label ?? "Stack on space…"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {baseOptions.map((option) => (
                  <SelectItem data-lecturn-hover key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      ) : row.mode === "reference" ? (
        <Input
          size="sm"
          className="font-mono"
          value={row.ref}
          placeholder={
            defaultBranch === undefined ? "pin to a ref" : `pin to a ref (${defaultBranch})`
          }
          spellCheck={false}
          aria-label={`${row.repo} reference`}
          onChange={(event) => onRef(event.target.value)}
        />
      ) : null}
    </div>
  );
}

/** Registers a repo with `stave repos add` and reports when the registry changed. */
function RegisterRepoForm(props: {
  readonly environmentId: EnvironmentId;
  readonly registry: ReadonlyArray<StaveRepoRow>;
  readonly onRegistered: () => void;
}) {
  const { environmentId, registry, onRegistered } = props;
  const [form, setForm] = useState(EMPTY_REGISTER_REPO_FORM);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const runOperation = useAtomCommand(staveOperations.run, { reportFailure: false });
  const gate = validateRegisterRepoForm(form, registry);
  const compatibility = useStaveStatus(environmentId);
  const unavailableReason = staveOperationUnavailableReason(compatibility.data, "registerRepo");
  const canRegister = gate.ok && !submitting && unavailableReason === null;

  const register = async () => {
    if (!canRegister) return;
    const id = randomUUID();
    setOperationId(id);
    setSubmitting(true);
    const result = await runOperation({
      environmentId,
      operationId: id,
      operation: buildRegisterRepoOperation(form),
    });
    setSubmitting(false);
    if (result._tag === "Success" && result.value.status === "finished") {
      setForm(EMPTY_REGISTER_REPO_FORM);
      onRegistered();
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border/70 p-2.5">
      <p className="text-sm font-medium">Register a repo</p>
      {unavailableReason ? (
        <p className="text-xs text-muted-foreground">{unavailableReason}</p>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-2"
        onKeyDown={(event) => {
          // Enter submits this form rather than advancing the wizard.
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.stopPropagation();
          event.preventDefault();
          void register();
        }}
      >
        <Input
          size="sm"
          className="w-36"
          value={form.name}
          placeholder="name"
          spellCheck={false}
          aria-label="Repo name"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <Input
          size="sm"
          className="min-w-48 flex-1 font-mono"
          value={form.url}
          placeholder="git@host:org/repo.git or /path"
          spellCheck={false}
          aria-label="Clone URL or path"
          onChange={(event) => setForm({ ...form, url: event.target.value })}
        />
        <Label className="gap-1.5 font-normal">
          <Checkbox
            data-lecturn-hover
            checked={form.adopt}
            onCheckedChange={(checked) => setForm({ ...form, adopt: checked === true })}
          />
          Adopt existing cache
        </Label>
        <Button size="sm" variant="outline" disabled={!canRegister} onClick={() => void register()}>
          {submitting ? "Registering…" : "Register"}
        </Button>
      </div>
      {!gate.ok && (form.name.length > 0 || form.url.length > 0) ? (
        <p className="text-xs text-muted-foreground">{gate.message}</p>
      ) : null}
      {operationId !== null ? (
        <StaveOperationProgress compact environmentId={environmentId} operationId={operationId} />
      ) : null}
    </div>
  );
}

/** Which registered repos the space edits or references, plus registry additions. */
export function ReposStep(props: {
  readonly environmentId: EnvironmentId;
  readonly state: StaveSpaceWizardState;
  readonly context: StaveWizardContext;
  readonly onChange: (next: StaveSpaceWizardState) => void;
  readonly onRepoRegistered: () => void;
}) {
  const { environmentId, state, context, onChange, onRepoRegistered } = props;
  const registryByName = new Map(context.repos.map((row) => [row.name, row] as const));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {state.repos.length === 0 ? (
          <p className="rounded-lg border border-border/70 bg-muted/35 p-3 text-sm text-muted-foreground">
            No repos are registered with Stave yet. Register one below, or create an empty space.
          </p>
        ) : (
          state.repos.map((row) => (
            <RepoRow
              key={row.repo}
              row={row}
              registry={registryByName.get(row.repo)}
              context={context}
              onMode={(mode) => onChange(setRepoMode(state, row.repo, mode))}
              onBase={(base) => onChange(setRepoBase(state, row.repo, base))}
              onRef={(ref) => onChange(setRepoRef(state, row.repo, ref))}
            />
          ))
        )}
        <Label className="gap-1.5 font-normal">
          <Checkbox
            data-lecturn-hover
            checked={state.emptySpace}
            onCheckedChange={(checked) =>
              onChange(updateWizardState(state, { emptySpace: checked === true }))
            }
          />
          Empty space (no repos)
        </Label>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="stave-wizard-common" className="font-normal">
            Include commonly paired references (-c)
          </Label>
          <Switch
            data-lecturn-hover
            id="stave-wizard-common"
            size="sm"
            checked={state.common}
            onCheckedChange={(checked) => onChange(updateWizardState(state, { common: checked }))}
          />
        </div>
        <div className="flex items-center justify-between gap-3 ps-4">
          <Label htmlFor="stave-wizard-include-weak" className="font-normal text-muted-foreground">
            Include weak tethers
          </Label>
          <Switch
            data-lecturn-hover
            id="stave-wizard-include-weak"
            size="sm"
            disabled={!state.common}
            checked={state.includeWeak}
            onCheckedChange={(checked) =>
              onChange(updateWizardState(state, { includeWeak: checked }))
            }
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="stave-wizard-no-learn" className="font-normal">
            Skip tether learning (--no-learn)
          </Label>
          <Switch
            data-lecturn-hover
            id="stave-wizard-no-learn"
            size="sm"
            checked={state.noLearn}
            onCheckedChange={(checked) => onChange(updateWizardState(state, { noLearn: checked }))}
          />
        </div>
      </div>

      <RegisterRepoForm
        environmentId={environmentId}
        registry={context.repos}
        onRegistered={onRepoRegistered}
      />
    </div>
  );
}
