import { useAtomValue } from "@effect/atom-react";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  Squire,
  SquireRole,
} from "@lecturn/contracts";
import { useState, type ReactNode } from "react";

import { cn, randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Alert, AlertDescription } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { Spinner } from "../../ui/spinner";
import { SQUIRE_PALETTE_TINT } from "../squirePaletteTint";
import {
  squireCommandError,
  squireDefaultProvider,
  squireSetupSaveState,
  squireSetupSections,
  squireUpdatePatch,
  SQUIRE_NO_SUPPORTED_PROVIDER,
  type SquireProviderOption,
  type SquireSetupDraft,
  type SquireSetupSectionId,
} from "./squireSetup.logic";
import { closeSquireSetup, type SquireSetupTarget } from "./squireSetupStore";
import {
  SquireBriefSection,
  SquireIdentitySection,
  SquireProviderSection,
  type SetupFieldsProps,
} from "./SquireSetupBasics";
import { SquireCompanionSection } from "./SquireCompanionSection";
import { SquireLeadActions } from "./SquireLeadActions";
import {
  SquireBudgetsSection,
  SquireDigestSection,
  SquireEventsSection,
  SquirePermissionsSection,
  SquireSweepSection,
} from "./SquireSetupPolicy";
import { SetupSection } from "./SquireSetupLayout";
import { SquireRulesSection } from "./SquireRulesSection";
import { SquireScopeSection } from "./SquireScopeSection";
import { SquireTriggersSection } from "./SquireTriggersSection";

// Paths come from assets/squire/threadkeeper.svg (two-tone, dark) and threadkeeper-mono.svg
// (currentColor, light), the sources of truth; the pale strand washes out on light.
const LOGO_STRAND = "M82 22C48 13 25 29 32 48C39 67 95 62 97 86C98.5 104 75 113 49 106";
const LOGO_THREAD = "M82 22C55 17 44 34 51 46C61 61 101 61 105 83C110 103 79 114 49 106";
const LOGO_LOOP = "M25 62C24 80 48 82 65 84C87 87 91 104 49 106";
const LOGO_STAR = "M82 12C83 20 84 21 92 22C84 23 83 24 82 32C81 24 80 23 72 22C80 21 81 20 82 12Z";

/** One of the two logo placements. */
function SquireSetupLogo() {
  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      aria-hidden="true"
      className={cn("size-9 shrink-0", SQUIRE_PALETTE_TINT.brass)}
    >
      <g strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.1}>
        <path d={LOGO_STRAND} className="stroke-(--squire-strand) light:stroke-current" />
        <path d={LOGO_THREAD} className="stroke-(--squire-thread) light:stroke-current" />
        <path d={LOGO_LOOP} className="stroke-(--squire-thread) light:stroke-current" />
      </g>
      <g className="fill-(--squire-thread) light:fill-current">
        <circle cx="25" cy="62" r="2.7" />
        <circle cx="49" cy="106" r="2.7" />
        <path d={LOGO_STAR} />
      </g>
    </svg>
  );
}

export function SquireSetupFrame(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) closeSquireSetup();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <SquireSetupLogo />
            <SheetTitle>{props.title}</SheetTitle>
          </div>
        </SheetHeader>
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}

/** Shown in place of the form while the brief loads, with save disabled. */
export function SquireSetupPending(props: { readonly error: string | null }) {
  return (
    <>
      <div className="flex min-h-0 flex-1 items-start justify-center px-6 py-8">
        {props.error === null ? (
          <Spinner />
        ) : (
          <p className="text-sm text-muted-foreground">{props.error}</p>
        )}
      </div>
      <SetupFooter reason={null} error={null} saving={false} canSave={false} onSave={() => {}} />
    </>
  );
}

function SetupFooter(props: {
  readonly reason: string | null;
  readonly error: string | null;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 px-6 py-3">
      {props.error === null ? null : (
        <Alert variant="error">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2">
        {props.reason === null ? null : (
          <span className="me-auto text-xs text-muted-foreground">{props.reason}</span>
        )}
        <Button variant="ghost" onClick={closeSquireSetup}>
          Cancel
        </Button>
        <Button disabled={!props.canSave || props.saving} onClick={props.onSave}>
          {props.saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

type SaveOutcome =
  | { readonly saved: true }
  | { readonly saved: false; readonly error: string | null };
const SAVED: SaveOutcome = { saved: true };
/** A null error is an interrupted command: the sheet stays open without a message. */
const failed = (error: string | null): SaveOutcome => ({ saved: false, error });

export interface SquireSetupFormProps {
  readonly target: SquireSetupTarget;
  readonly environmentId: EnvironmentId;
  readonly role: SquireRole;
  /** The full record for edit, latest first; null for create and proposal. */
  readonly squire: Squire | null;
  readonly entry: SquireSnapshotEntry | null;
  readonly initialDraft: SquireSetupDraft;
  readonly options: ReadonlyArray<SquireProviderOption>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}

export function SquireSetupForm(props: SquireSetupFormProps) {
  const { target, environmentId, role, squire, entry, options, projects } = props;
  const [draft, setDraft] = useState(props.initialDraft);
  // The record the draft started from, so the patch carries only the user's own changes even
  // after a concurrent edit refetches `squire`.
  const [base] = useState(squire);
  // Stable across retries, so a create that landed before a failed dismiss is not repeated.
  const [createRequestId] = useState(randomUUID);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = useAtomValue(squireEnvironment.create.permissionAtom(environmentId));
  const canUpdate = useAtomValue(squireEnvironment.update.permissionAtom(environmentId));
  const canDismiss = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const create = useAtomCommand(squireEnvironment.create, { reportFailure: false });
  const updateSquire = useAtomCommand(squireEnvironment.update, { reportFailure: false });
  const itemsAct = useAtomCommand(squireEnvironment.itemsAct, { reportFailure: false });

  const canWrite =
    target.kind === "edit" ? canUpdate : canCreate && (target.kind === "create" || canDismiss);
  // Defaults that arrive after mount (provider support, projects) fill what the user left empty.
  const effective: SquireSetupDraft = {
    ...draft,
    homeProjectId: draft.homeProjectId ?? projects[0]?.id ?? null,
    providerInstanceId: draft.providerInstanceId ?? squireDefaultProvider(options),
  };
  const saveState = squireSetupSaveState(effective, options);
  const reason = !canWrite ? "Read-only access" : saveState.canSave ? null : saveState.reason;
  const update = (patch: Partial<SquireSetupDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const fields: SetupFieldsProps = { draft: effective, update, disabled: !canWrite || saving };

  const saveCreate = async () => {
    const { homeProjectId, providerInstanceId } = effective;
    if (homeProjectId === null || providerInstanceId === null) return failed(null);
    const created = await create({
      environmentId,
      input: {
        requestId: createRequestId,
        homeProjectId,
        providerInstanceId,
        name: effective.name.trim(),
        brief: effective.brief,
        ...(effective.modelSelection === null ? {} : { modelSelection: effective.modelSelection }),
        ...(effective.summaryModelSelection === null
          ? {}
          : { summaryModelSelection: effective.summaryModelSelection }),
        grants: effective.grants,
        events: effective.events,
        permissions: effective.permissions,
        budgets: effective.budgets,
        undoWindowSeconds: effective.undoWindowSeconds,
        companion: effective.companion,
      },
    });
    if (created._tag === "Failure") {
      return failed(squireCommandError(created, "The Squire could not be created."));
    }
    if (target.kind !== "proposal") return SAVED;
    // The server's accept ignores edits, so Edit creates here and retires the proposal.
    const dismissed = await itemsAct({
      environmentId,
      input: { requestId: randomUUID(), cardIds: [target.cardId], action: "dismiss" },
    });
    if (dismissed._tag === "Failure") {
      return failed(
        squireCommandError(dismissed, "Created, but the proposal could not be dismissed."),
      );
    }
    const refused = dismissed.value.results.find((result) => result.error !== null)?.error;
    return refused == null ? SAVED : failed(refused.message);
  };

  const saveUpdate = async () => {
    if (base === null || squire === null) return failed(null);
    const { providerInstanceId, modelSelection, sweep, ...rest } = squireUpdatePatch(
      base,
      effective,
    );
    const input = {
      ...rest,
      ...(providerInstanceId == null ? {} : { providerInstanceId }),
      ...(modelSelection == null ? {} : { modelSelection }),
      ...(sweep == null ? {} : { sweep }),
    };
    if (Object.keys(input).length === 0) return SAVED;
    const result = await updateSquire({
      environmentId,
      input: {
        requestId: randomUUID(),
        squireId: squire.id,
        expectedRevision: squire.revision,
        ...input,
      },
    });
    return result._tag === "Failure"
      ? failed(squireCommandError(result, "The changes could not be saved."))
      : SAVED;
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const outcome = target.kind === "edit" ? await saveUpdate() : await saveCreate();
    setSaving(false);
    if (outcome.saved) closeSquireSetup();
    else setError(outcome.error);
  };

  const section = (id: SquireSetupSectionId) => {
    switch (id) {
      case "identity":
        return (
          <SquireIdentitySection
            key={id}
            {...fields}
            projects={target.kind === "edit" ? null : projects}
            homeProjectTitle={
              projects.find((project) => project.id === effective.homeProjectId)?.title ?? null
            }
          />
        );
      case "provider":
        return (
          <SquireProviderSection
            key={id}
            {...fields}
            options={options}
            providers={props.providers}
            noSupportedProvider={reason === SQUIRE_NO_SUPPORTED_PROVIDER}
          />
        );
      case "brief":
        return <SquireBriefSection key={id} {...fields} />;
      case "scope":
        return <SquireScopeSection key={id} {...fields} environmentId={environmentId} />;
      case "events":
        return <SquireEventsSection key={id} {...fields} />;
      case "permissions":
        return (
          <SquirePermissionsSection
            key={id}
            {...fields}
            environmentId={environmentId}
            isLead={role === "lead"}
            entry={entry}
          />
        );
      case "rules":
        return (
          <SetupSection key={id} title="Rules">
            {squire === null ? (
              <SavedFirst />
            ) : (
              <SquireRulesSection environmentId={environmentId} squire={squire} />
            )}
          </SetupSection>
        );
      case "triggers":
        return (
          <SetupSection key={id} title="Triggers">
            {squire === null ? (
              <SavedFirst />
            ) : (
              <SquireTriggersSection environmentId={environmentId} squire={squire} />
            )}
          </SetupSection>
        );
      case "budgets":
        return <SquireBudgetsSection key={id} {...fields} entry={entry} />;
      case "digest":
        return <SquireDigestSection key={id} {...fields} />;
      case "sweep":
        return squire === null ? null : (
          <SquireSweepSection
            key={id}
            {...fields}
            environmentId={environmentId}
            leadId={squire.id}
          />
        );
      case "companion":
        return (
          <SquireCompanionSection
            key={id}
            {...fields}
            isLead={role === "lead"}
            environmentId={environmentId}
            entry={entry}
          />
        );
      case "leadActions":
        return squire === null ? null : (
          <SquireLeadActions key={id} environmentId={environmentId} leadId={squire.id} />
        );
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">{squireSetupSections(role).map(section)}</div>
      <SetupFooter
        reason={reason}
        error={error}
        saving={saving}
        canSave={canWrite && saveState.canSave}
        onSave={() => void save()}
      />
    </>
  );
}

function SavedFirst() {
  return <p className="text-sm text-muted-foreground">Available once the Squire is saved.</p>;
}
