import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createSquireOpenedTracker,
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
import { useEffect } from "react";

import { useWindowFocused } from "../../../hooks/useWindowFocused";
import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";

/** Enough to cover the Squire's chat; older approvals age out of it. */
const SQUIRE_CHAT_ROWS_LIMIT = 200;
const CHAT_KINDS: ReadonlyArray<SquireCardKind> = ["steer", "question", "overlap", "proposal"];
const FYI_KINDS: ReadonlyArray<SquireCardKind> = ["fyi"];

const NO_ROWS: ReadonlyArray<SquireCardRow> = [];

// Open rows load on their own: the closed history is capped newest first, and an old open row
// must keep its place in the chat while the badge says it needs you. Open FYIs load separately
// so a long history never crowds out the inactivity check.
const chatRowsAtom = Atom.family((key: string) => {
  const [environmentId, squireId, chatFirst] = JSON.parse(key) as [
    EnvironmentId,
    SquireId,
    boolean,
  ];
  const page = (
    get: Atom.AtomContext,
    scope: "open" | "all",
    kinds: ReadonlyArray<SquireCardKind>,
  ) =>
    Option.getOrNull(
      AsyncResult.value(
        get(
          squireEnvironment.items({
            environmentId,
            input: { squireId, scope, kinds, limit: SQUIRE_CHAT_ROWS_LIMIT },
          }),
        ),
      ),
    )?.items ?? NO_ROWS;
  return Atom.make((get): ReadonlyArray<SquireCardRow> => {
    const byId = new Map<SquireCardId, SquireCardRow>();
    for (const row of chatFirst ? page(get, "all", CHAT_KINDS) : NO_ROWS) byId.set(row.id, row);
    for (const row of page(get, "open", CHAT_KINDS)) byId.set(row.id, row);
    for (const row of page(get, "open", FYI_KINDS)) byId.set(row.id, row);
    return byId.size === 0 ? NO_ROWS : [...byId.values()];
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

const squireOpenedThisSession = createSquireOpenedTracker();

/**
 * Marks a card opened once it is on screen in a focused window, which cancels its phone
 * escalation. An unfocused window has been seen by nobody, so the phone must still alert.
 */
export function useSquireMarkOpened(
  environmentId: EnvironmentId,
  cardId: SquireCardId | null,
  openedAt: string | null,
) {
  const canMark = useAtomValue(squireEnvironment.itemsMarkOpened.permissionAtom(environmentId));
  const markOpened = useAtomCommand(squireEnvironment.itemsMarkOpened, { reportFailure: false });
  const windowFocused = useWindowFocused();
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- tells the server a card reached the screen.
  useEffect(() => {
    if (cardId === null || !canMark || !windowFocused) return;
    if (!squireOpenedThisSession.take(environmentId, cardId, openedAt)) return;
    void markOpened({ environmentId, input: { requestId: randomUUID(), cardIds: [cardId] } }).then(
      (result) => {
        if (result._tag === "Failure") squireOpenedThisSession.release(environmentId, cardId);
      },
    );
  }, [environmentId, cardId, openedAt, canMark, markOpened, windowFocused]);
}
