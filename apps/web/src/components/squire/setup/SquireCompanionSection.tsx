import {
  squireFigureState,
  squireStateLine,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCompanion as SquireCompanionChoice } from "@lecturn/contracts";

import { SquireCompanion } from "../SquireCompanion";
import { useSquireIndicator } from "../SquireHeader";
import { EMBLEM_CHOICES, RIG_CHOICES } from "../companion/types";
import { SQUIRE_PALETTE_CHOICES, squireCompanionForRole } from "./squireSetup.logic";
import type { SetupFieldsProps } from "./SquireSetupBasics";
import {
  SetupRow,
  SetupSection,
  SetupSegmented,
  SetupSelect,
  setupOptions,
} from "./SquireSetupLayout";

const PRESENCE = [
  { value: "figure", label: "Figure" },
  { value: "emblem", label: "Emblem" },
] as const;
const APPEARANCE = setupOptions(RIG_CHOICES.appearance);
const HOOD = setupOptions(RIG_CHOICES.hood);
const EQUIPMENT = setupOptions(RIG_CHOICES.equipment);
const FRAME = setupOptions(EMBLEM_CHOICES.frame);
const WEIGHT = setupOptions(EMBLEM_CHOICES.weight);
const GLOW = setupOptions(EMBLEM_CHOICES.glow);
const MOTION = setupOptions(RIG_CHOICES.motion);
const PALETTE = setupOptions(SQUIRE_PALETTE_CHOICES);

/** P16.2, with the P16.5(d) live preview, which outranks the view's panel for the one live rig. */
export function SquireCompanionSection(
  props: SetupFieldsProps & {
    readonly isLead: boolean;
    readonly environmentId: EnvironmentId;
    /** Null while creating: a new Squire has no state yet. */
    readonly entry: SquireSnapshotEntry | null;
  },
) {
  const { draft, update, disabled, isLead, environmentId, entry } = props;
  const companion = draft.companion;
  const set = (patch: Partial<SquireCompanionChoice>) =>
    update({
      companion: squireCompanionForRole({ ...companion, ...patch }, isLead ? "lead" : "squire"),
    });
  const figure = companion.presence === "figure";
  const name = draft.name.trim() || "New Squire";
  return (
    <SetupSection title="Companion">
      <div className="flex flex-col gap-3">
        {entry === null ? (
          <SquirePreviewFigure
            companion={companion}
            isLead={isLead}
            name={name}
            figureState="idle"
            stateLine="Idle · new Squire"
          />
        ) : (
          <SquireLivePreview
            environmentId={environmentId}
            entry={entry}
            companion={companion}
            isLead={isLead}
            name={name}
          />
        )}
        <div className="flex flex-col gap-2">
          <SetupRow label="Presence">
            <SetupSegmented
              label="Presence"
              value={companion.presence}
              options={PRESENCE}
              disabled={disabled}
              onChange={(presence) => set({ presence })}
            />
          </SetupRow>
          {figure ? (
            <>
              <SetupRow label="Appearance">
                <SetupSegmented
                  label="Appearance"
                  value={companion.appearance}
                  options={APPEARANCE}
                  disabled={disabled}
                  onChange={(appearance) => set({ appearance })}
                />
              </SetupRow>
              <SetupRow label="Hood">
                <SetupSegmented
                  label="Hood"
                  value={companion.hood}
                  options={HOOD}
                  disabled={disabled}
                  onChange={(hood) => set({ hood })}
                />
              </SetupRow>
              <SetupRow label="Equipment">
                <SetupSelect
                  label="Equipment"
                  value={companion.equipment}
                  options={EQUIPMENT}
                  disabled={disabled}
                  onChange={(equipment) => set({ equipment })}
                />
              </SetupRow>
            </>
          ) : (
            <>
              <SetupRow label="Frame">
                <SetupSelect
                  label="Frame"
                  value={companion.frame}
                  options={FRAME}
                  disabled={disabled}
                  onChange={(frame) => set({ frame })}
                />
              </SetupRow>
              <SetupRow label="Weight">
                <SetupSelect
                  label="Weight"
                  value={companion.weight}
                  options={WEIGHT}
                  disabled={disabled}
                  onChange={(weight) => set({ weight })}
                />
              </SetupRow>
              <SetupRow label="Glow">
                <SetupSelect
                  label="Glow"
                  value={companion.glow}
                  options={GLOW}
                  disabled={disabled}
                  onChange={(glow) => set({ glow })}
                />
              </SetupRow>
            </>
          )}
          <SetupRow label="Palette">
            {isLead ? (
              <span className="text-sm text-muted-foreground">Gold, the Lead's</span>
            ) : (
              <SetupSelect
                label="Palette"
                value={companion.palette === "gold" ? "brass" : companion.palette}
                options={PALETTE}
                disabled={disabled}
                onChange={(palette) => set({ palette })}
              />
            )}
          </SetupRow>
          <SetupRow label="Motion">
            <SetupSelect
              label="Motion"
              value={companion.motion}
              options={MOTION}
              disabled={disabled}
              onChange={(motion) => set({ motion })}
            />
          </SetupRow>
        </div>
      </div>
    </SetupSection>
  );
}

/** The draft's look in the Squire's real current state, as its panel would show it now. */
function SquireLivePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly companion: SquireCompanionChoice;
  readonly isLead: boolean;
  readonly name: string;
}) {
  const { entry } = props;
  const indicator = useSquireIndicator(props.environmentId, entry);
  return (
    <SquirePreviewFigure
      companion={props.companion}
      isLead={props.isLead}
      name={props.name}
      figureState={squireFigureState(indicator.state)}
      stateLine={squireStateLine({
        squire: entry.squire,
        indicator,
        openDecisionCount: entry.openDecisionCount,
        heldCount: entry.held.length,
      })}
    />
  );
}

function SquirePreviewFigure(props: {
  readonly companion: SquireCompanionChoice;
  readonly isLead: boolean;
  readonly name: string;
  readonly figureState: ReturnType<typeof squireFigureState>;
  readonly stateLine: string;
}) {
  return (
    // On the sheet's own surface, as the view's panel shows it (facing the same way): a figure
    // 240 x 300 on the 1122 x 1402 stage, an emblem 240 square.
    <figure className="flex flex-col items-center gap-1 py-2">
      <SquireCompanion
        companion={props.companion}
        state={props.figureState}
        placement="overlay"
        crest={props.isLead}
        label={`${props.name} preview: ${props.stateLine}`}
        className="w-60"
        facesContent
      />
      <figcaption className="flex flex-col items-center text-center">
        <span className="text-sm font-medium">{props.name}</span>
        <span className="text-xs text-muted-foreground">{props.stateLine}</span>
      </figcaption>
    </figure>
  );
}
