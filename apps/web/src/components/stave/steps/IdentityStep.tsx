import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  STAVE_SPACE_KIND_CHIPS,
  type StaveSpaceKindChip,
  type StaveSpaceWizardState,
  type StaveWizardContext,
  updateWizardState,
  validateSpaceId,
  validateSpaceKind,
} from "../staveSpaceWizard.logic";

function isKindChip(value: unknown): value is StaveSpaceKindChip {
  return STAVE_SPACE_KIND_CHIPS.some((chip) => chip === value);
}

/** Id, title, kind and spec of the new space. */
export function IdentityStep(props: {
  readonly state: StaveSpaceWizardState;
  readonly context: StaveWizardContext;
  readonly onChange: (next: StaveSpaceWizardState) => void;
}) {
  const { state, context, onChange } = props;
  const id = validateSpaceId(state.spaceId, context.spaces);
  const kind = validateSpaceKind(state);
  const idMessage = state.spaceId.length > 0 && !id.ok ? id.message : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stave-wizard-space-id">Space id</Label>
        <Input
          id="stave-wizard-space-id"
          autoFocus
          size="sm"
          value={state.spaceId}
          placeholder="my-ticket-123"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={idMessage === undefined ? undefined : true}
          onChange={(event) => onChange(updateWizardState(state, { spaceId: event.target.value }))}
        />
        {idMessage !== undefined ? (
          <p className="text-xs text-destructive-foreground">{idMessage}</p>
        ) : id.warning !== undefined ? (
          <p className="text-xs text-muted-foreground">{id.warning}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stave-wizard-space-title">Title</Label>
        <Input
          id="stave-wizard-space-title"
          size="sm"
          value={state.title}
          placeholder={state.spaceId.trim().length > 0 ? state.spaceId.trim() : "defaults to id"}
          onChange={(event) => onChange(updateWizardState(state, { title: event.target.value }))}
        />
        <p className="text-xs text-muted-foreground">Project title in Lecturn; defaults to id.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id="stave-wizard-kind-label">Kind</Label>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-labelledby="stave-wizard-kind-label"
            size="sm"
            variant="outline"
            value={[state.kindChip]}
            onValueChange={(value) => {
              const next = value[0];
              if (isKindChip(next)) onChange(updateWizardState(state, { kindChip: next }));
            }}
          >
            {STAVE_SPACE_KIND_CHIPS.map((chip) => (
              <Toggle key={chip} value={chip} className="px-2.5 capitalize">
                {chip}
              </Toggle>
            ))}
          </ToggleGroup>
          {state.kindChip === "custom" ? (
            <Input
              size="sm"
              className="w-40"
              value={state.customKind}
              placeholder="custom kind"
              spellCheck={false}
              aria-label="Custom kind"
              aria-invalid={kind.ok ? undefined : true}
              onChange={(event) =>
                onChange(updateWizardState(state, { customKind: event.target.value }))
              }
            />
          ) : null}
        </div>
        {!kind.ok && state.customKind.length > 0 ? (
          <p className="text-xs text-destructive-foreground">{kind.message}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stave-wizard-spec-text">Spec</Label>
        <Textarea
          id="stave-wizard-spec-text"
          size="sm"
          rows={5}
          value={state.specText}
          placeholder="Paste the ticket, brief or design note the space is for."
          onChange={(event) => onChange(updateWizardState(state, { specText: event.target.value }))}
        />
        <Label htmlFor="stave-wizard-spec-path" className="mt-1 text-muted-foreground">
          or a spec path on the server
        </Label>
        <Input
          id="stave-wizard-spec-path"
          size="sm"
          value={state.specPath}
          placeholder="/absolute/path/to/spec.md"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => onChange(updateWizardState(state, { specPath: event.target.value }))}
        />
      </div>
    </div>
  );
}
