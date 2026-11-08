import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import {
  squireApprovalEntries,
  type SquireApprovalEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireItemAction,
} from "@lecturn/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment, useSquireEntry } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  squireActOutcome,
  squireItemsActInput,
  squireOpenedThisSession,
  squireWithInactivityChecks,
  type SquireActOutcome,
  type SquireAnswer,
} from "./squireApproval.logic";

const NO_ITEMS: ReadonlyArray<SquireCardRow> = [];
const APPROVAL_KINDS = ["steer", "proposal", "question", "overlap"] as const;
const CLOSED_PAGE_LIMIT = 100;

/**
 * The rows a Squire's chat renders, oldest first. Every open row counts, with the newest
 * closed rows on a chat-first server, so one that expired or was denied keeps its place in the
 * feed. Older servers list open rows only, and keep the combined queue on the Lead.
 */
export function useSquireChatApprovals(
  environmentId: EnvironmentId,
  squireId: SquireId | null,
  chatFirst: boolean,
): ReadonlyArray<SquireApprovalEntry<SquireCardRow>> {
  const entry = useSquireEntry(environmentId, squireId);
  const open = useEnvironmentQuery(
    squireId === null
      ? null
      : squireEnvironment.items({
          environmentId,
          input: { squireId, scope: "open", kinds: [...APPROVAL_KINDS] },
        }),
  );
  const fyis = useEnvironmentQuery(
    squireId === null
      ? null
      : squireEnvironment.items({
          environmentId,
          input: { squireId, scope: "open", kinds: ["fyi"] },
        }),
  );
  const recent = useEnvironmentQuery(
    squireId === null || !chatFirst
      ? null
      : squireEnvironment.items({
          environmentId,
          input: {
            squireId,
            scope: "all",
            kinds: [...APPROVAL_KINDS],
            limit: CLOSED_PAGE_LIMIT,
          },
        }),
  );
  if (squireId === null) return EMPTY_APPROVALS;
  const byId = new Map<SquireCardId, SquireCardRow>();
  for (const row of open.data?.items ?? NO_ITEMS) byId.set(row.id, row);
  for (const row of recent.data?.items ?? NO_ITEMS) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const chat = { squireId, isLead: entry?.squire.role === "lead", chatFirst };
  return squireWithInactivityChecks(
    squireApprovalEntries([...byId.values()], chat),
    fyis.data?.items ?? NO_ITEMS,
    chat,
  );
}

const EMPTY_APPROVALS: ReadonlyArray<SquireApprovalEntry<SquireCardRow>> = [];

/** Rules this session saved from a chat row; a row's "Saved to rules" outlasts its card closing. */
export const squireSavedRuleCardsAtom = Atom.make(
  new Set<SquireCardId>() as ReadonlySet<SquireCardId>,
).pipe(Atom.keepAlive, Atom.withLabel("mobile-squire-saved-rule-cards"));

/** `squire.items.act` with a fresh request id; failures come back as the card's inline error. */
export function useSquireItemsAct(environmentId: EnvironmentId) {
  const act = useAtomCommand(squireEnvironment.itemsAct, { reportFailure: false });
  const canAct = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const run = async (
    cardIds: ReadonlyArray<SquireCardId>,
    action: SquireItemAction,
    extra: { readonly text?: string | undefined; readonly answer?: SquireAnswer } = {},
  ): Promise<SquireActOutcome | null> => {
    const result = await act({
      environmentId,
      input: squireItemsActInput(uuidv4(), cardIds, action, extra),
    });
    if (result._tag === "Failure" && isAtomCommandInterrupted(result)) return null;
    const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    const message = error instanceof Error && error.message.trim() !== "" ? error.message : null;
    return squireActOutcome(result, cardIds[0]!, message);
  };
  return { canAct, run };
}

/** Marks the expanded card opened, once per card per app session. */
export function useSquireMarkOpened(
  environmentId: EnvironmentId,
  cardId: SquireCardId | null,
  openedAt: string | null | undefined,
) {
  const canMark = useAtomValue(squireEnvironment.itemsMarkOpened.permissionAtom(environmentId));
  const markOpened = useAtomCommand(squireEnvironment.itemsMarkOpened, { reportFailure: false });
  // oxlint-disable-next-line lecturn/react-effect-budget -- a row coming into view is the event; the mark is a one-off server write.
  useEffect(() => {
    // Wait for the row or card, so a card some surface already opened is never re-sent.
    if (cardId === null || openedAt === undefined || !canMark) return;
    if (!squireOpenedThisSession.take(environmentId, cardId, openedAt)) return;
    void markOpened({
      environmentId,
      input: { requestId: uuidv4(), cardIds: [cardId] },
    }).then((result) => {
      if (result._tag === "Failure") squireOpenedThisSession.release(environmentId, cardId);
    });
  }, [environmentId, cardId, openedAt, canMark, markOpened]);
}
