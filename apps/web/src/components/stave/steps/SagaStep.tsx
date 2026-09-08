import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  sagaIdOf,
  sagaMemberOptions,
  setSaga,
  type StaveSpaceWizardState,
  type StaveWizardContext,
  toggleAfterMember,
} from "../staveSpaceWizard.logic";

const NONE = "__none__";

/** Optional saga enrolment and the members the new space lands after. */
export function SagaStep(props: {
  readonly state: StaveSpaceWizardState;
  readonly context: StaveWizardContext;
  readonly onChange: (next: StaveSpaceWizardState) => void;
}) {
  const { state, context, onChange } = props;
  const members = sagaMemberOptions(context.sagas, state.sagaId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label id="stave-wizard-saga-label">Saga</Label>
        <Select
          value={state.sagaId ?? NONE}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            onChange(setSaga(state, value === NONE ? null : value));
          }}
        >
          <SelectTrigger size="sm" aria-labelledby="stave-wizard-saga-label">
            <SelectValue>{state.sagaId ?? "None"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value={NONE}>None</SelectItem>
            {context.sagas.map((row) => {
              const id = sagaIdOf(row);
              return (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        {context.sagas.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sagas exist yet.</p>
        ) : null}
      </div>

      {state.sagaId !== null ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Land after</p>
          {members.length === 0 ? (
            <p className="text-xs text-muted-foreground">This saga has no members yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {members.map((member) => (
                <Label key={member} className="gap-1.5 font-normal">
                  <Checkbox
                    checked={state.after.includes(member)}
                    onCheckedChange={() => onChange(toggleAfterMember(state, member))}
                  />
                  <span className="font-mono">{member}</span>
                </Label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Stave infers stacking bases from --after; the review shows what it will do.
          </p>
        </div>
      ) : null}
    </div>
  );
}
