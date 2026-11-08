import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireItemAction,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { uuidv4 } from "../../lib/uuid";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SQUIRE_QUEUE_PAGE_SIZE,
  squireActOutcome,
  squireItemsActInput,
  squireOpenedThisSession,
  type SquireActOutcome,
  type SquireAnswer,
} from "./squireQueue.logic";

export interface SquireQueuePages {
  readonly rows: ReadonlyArray<SquireCardRow>;
  readonly nextBefore: string | null;
  readonly loaded: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The queue could not be loaded.";
}

interface ItemsPage {
  readonly value: {
    readonly items: ReadonlyArray<SquireCardRow>;
    readonly nextBefore: string | null;
  } | null;
  readonly waiting: boolean;
  readonly error: string | null;
}

function readPage(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  squireId: SquireId,
  before: string | null,
): ItemsPage {
  const result = get(
    squireEnvironment.items({
      environmentId,
      input: {
        squireId,
        scope: "open",
        ...(before === null ? {} : { before }),
        limit: SQUIRE_QUEUE_PAGE_SIZE,
      },
    }),
  );
  return {
    value: Option.getOrNull(AsyncResult.value(result)),
    waiting: result.waiting,
    error: result._tag === "Failure" ? failureMessage(result.cause) : null,
  };
}

// Each page is its own query, so each refreshes on the queue's revision; this only chains
// them by `nextBefore` and merges, so the queue renders one list.
const pagesAtom = Atom.family((key: string) => {
  const [environmentId, squireId, pageCount] = JSON.parse(key) as [EnvironmentId, SquireId, number];
  return Atom.make((get): SquireQueuePages => {
    const rows: SquireCardRow[] = [];
    const seen = new Set<string>();
    let before: string | null = null;
    let loaded = false;
    let pending = false;
    let error: string | null = null;
    for (let page = 0; page < pageCount; page++) {
      const { value, waiting, error: pageError } = readPage(get, environmentId, squireId, before);
      if (waiting) pending = true;
      if (value === null) {
        error = pageError;
        break;
      }
      if (page === 0) loaded = true;
      for (const row of value.items) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
      before = value.nextBefore;
      if (before === null) break;
    }
    return { rows, nextBefore: before, loaded, pending, error };
  }).pipe(Atom.withLabel(`mobile-squire-queue-pages:${key}`));
});

export function useSquireQueuePages(
  environmentId: EnvironmentId,
  squireId: SquireId,
  pageCount: number,
): SquireQueuePages {
  return useAtomValue(pagesAtom(JSON.stringify([environmentId, squireId, pageCount])));
}

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
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- marks the expanded card opened on the server once per card per app session
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
