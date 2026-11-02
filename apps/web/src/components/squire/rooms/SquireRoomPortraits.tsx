import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";

import { cn } from "../../../lib/utils";
import { SquirePortrait } from "../SquireHeader";

/**
 * Lifts an idle indicator's grayscale and dim: where a portrait says who is in a room rather than
 * what they are doing, it reads at full color. Emblem presence keeps its palette-tinted mark.
 */
export const SQUIRE_MEMBER_FULL_COLOR =
  "[&_img]:opacity-100 [&_img]:grayscale-0 [&_[role=img]>svg]:opacity-100 [&_[role=img]>svg]:grayscale-0";

/** Up to three member portraits overlapped, then "+N". */
export function SquireRoomPortraits(props: {
  readonly environmentId: EnvironmentId;
  readonly portraits: ReadonlyArray<SquireId>;
  readonly overflow: number;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly size: number;
  readonly fullColor?: boolean;
}) {
  const entries = props.portraits.flatMap((squireId) => {
    const entry = props.squires.find((candidate) => candidate.squire.id === squireId);
    return entry === undefined ? [] : [entry];
  });
  return (
    <span
      className={cn("flex shrink-0 items-center", props.fullColor && SQUIRE_MEMBER_FULL_COLOR)}
      aria-hidden
    >
      {entries.map((entry, index) => (
        <span key={entry.squire.id} className={index === 0 ? "flex" : "-ml-1.5 flex"}>
          <SquirePortrait
            environmentId={props.environmentId}
            entry={entry}
            size={props.size}
            label={entry.squire.name}
          />
        </span>
      ))}
      {props.overflow > 0 ? (
        <span className="ml-0.5 text-2xs text-muted-foreground tabular-nums">
          +{props.overflow}
        </span>
      ) : null}
    </span>
  );
}
