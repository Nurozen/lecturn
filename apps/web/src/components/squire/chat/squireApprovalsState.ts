import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  squireApprovalEntries,
  type SquireApprovalEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  SquireCardId,
  SquireCardKind,
  SquireCardRow,
  SquireId,
  SquireItemAction,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";

/** Enough to cover the Squire's chat; older approvals age out of it. */
const SQUIRE_CHAT_ROWS_LIMIT = 200;
const CHAT_KINDS: ReadonlyArray<SquireCardKind> = ["steer", "question", "overlap", "proposal"];
const FYI_KINDS: ReadonlyArray<SquireCardKind> = ["fyi"];

const NO_ROWS: ReadonlyArray<SquireCardRow> = [];

// An older server cannot settle a row inline, so only open approvals show there. Open FYIs load
// on their own so a full history can never crowd out the inactivity check.
const chatRowsAtom = Atom.family((key: string) => {
  const [environmentId, squireId, chatFirst] = JSON.parse(key) as [
    EnvironmentId,
    SquireId,
    boolean,
  ];
  return Atom.make((get): ReadonlyArray<SquireCardRow> => {
    const decisions = Option.getOrNull(
      AsyncResult.value(
        get(
          squireEnvironment.items({
            environmentId,
            input: {
              squireId,
              scope: chatFirst ? "all" : "open",
              kinds: CHAT_KINDS,
              limit: SQUIRE_CHAT_ROWS_LIMIT,
            },
          }),
        ),
      ),
    );
    const fyis = Option.getOrNull(
      AsyncResult.value(
        get(
          squireEnvironment.items({
            environmentId,
            input: { squireId, scope: "open", kinds: FYI_KINDS, limit: SQUIRE_CHAT_ROWS_LIMIT },
          }),
        ),
      ),
    );
    if (decisions === null && fyis === null) return NO_ROWS;
    return [...(decisions?.items ?? []), ...(fyis?.items ?? [])];
  }).pipe(Atom.withLabel(`web-squire-chat-rows:${key}`));
});

export interface SquireChatApprovals {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly entries: ReadonlyArray<SquireApprovalEntry<SquireCardRow>>;
}

export function useSquireChatApprovals(input: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly isLead: boolean;
  readonly chatFirst: boolean;
  /** Onboarding proposals the panel above the chat already shows as cards. */
  readonly shownAbove: ReadonlySet<string>;
}): SquireChatApprovals {
  const { environmentId, squireId, isLead, chatFirst, shownAbove } = input;
  const rows = useAtomValue(chatRowsAtom(JSON.stringify([environmentId, squireId, chatFirst])));
  return {
    environmentId,
    squireId,
    entries: squireApprovalEntries(
      shownAbove.size === 0 ? rows : rows.filter((row) => !shownAbove.has(row.id)),
      { squireId, isLead, chatFirst },
    ),
  };
}

// Kept outside the row: the timeline's virtualized rows unmount off screen, and the server's
// row does not say a rule came from it.
const savedRuleAtom = Atom.family((key: string) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`web-squire-saved-rule:${key}`)),
);

export function useSquireApprovalRuleSaved(environmentId: EnvironmentId, cardId: SquireCardId) {
  const atom = savedRuleAtom(`${environmentId}:${cardId}`);
  return [useAtomValue(atom), useAtomSet(atom)] as const;
}

/** `squire.items.act` with a fresh request id; a retry of the same press is the server's job. */
export function useSquireItemsAct(environmentId: EnvironmentId) {
  const act = useAtomCommand(squireEnvironment.itemsAct, { reportFailure: false });
  const canAct = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const run = (
    cardIds: ReadonlyArray<SquireCardId>,
    action: SquireItemAction,
    extra: {
      readonly answer?:
        | {
            readonly decision?: ProviderApprovalDecision;
            readonly answers?: Record<string, unknown>;
          }
        | undefined;
    } = {},
  ) =>
    act({
      environmentId,
      input: {
        requestId: randomUUID(),
        cardIds: [...cardIds],
        action,
        ...(extra.answer === undefined ? {} : { answer: extra.answer }),
      },
    });
  return { canAct, run };
}
