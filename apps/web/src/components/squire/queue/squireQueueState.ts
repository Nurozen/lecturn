import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireItemAction,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { randomUUID } from "../../../lib/utils";
import { formatEnvironmentQueryError } from "../../../state/query";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SQUIRE_QUEUE_PAGE_SIZE } from "./squireQueue.logic";
import { squireOpenedThisSession } from "./squireOpened.logic";

export interface SquireQueuePages {
  readonly rows: ReadonlyArray<SquireCardRow>;
  readonly nextBefore: string | null;
  readonly loaded: boolean;
  readonly pending: boolean;
  readonly error: string | null;
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
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
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
  }).pipe(Atom.withLabel(`web-squire-queue-pages:${key}`));
});

export function useSquireQueuePages(
  environmentId: EnvironmentId,
  squireId: SquireId,
  pageCount: number,
): SquireQueuePages {
  return useAtomValue(pagesAtom(JSON.stringify([environmentId, squireId, pageCount])));
}

// The holds the queue shows on their own rows, by view; null while no queue has loaded. The
// page-level banner shows only the rest, e.g. holds a chip or team filter hides.
const shownHoldsAtom = Atom.family((key: string) =>
  Atom.make<ReadonlySet<string> | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-squire-shown-holds:${key}`),
  ),
);

export function useSquireShownHolds(environmentId: EnvironmentId, squireId: SquireId) {
  return useAtomValue(shownHoldsAtom(JSON.stringify([environmentId, squireId])));
}

export function usePublishSquireShownHolds(
  environmentId: EnvironmentId,
  squireId: SquireId,
  cardIds: ReadonlyArray<string> | null,
) {
  const set = useAtomSet(shownHoldsAtom(JSON.stringify([environmentId, squireId])));
  // Joined so the effect runs only when the shown set changes, not on every render.
  const joined = cardIds === null ? null : cardIds.join("\n");
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- holds the shown card set in the shared atom while mounted and releases it on unmount
  useEffect(() => {
    set(joined === null ? null : new Set(joined === "" ? [] : joined.split("\n")));
    return () => set(null);
  }, [joined, set]);
}

/** `squire.items.act` with a fresh request id; a retry of the same press is the server's job. */
export function useSquireItemsAct(environmentId: EnvironmentId) {
  const act = useAtomCommand(squireEnvironment.itemsAct, { reportFailure: false });
  const canAct = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const run = (
    cardIds: ReadonlyArray<SquireCardId>,
    action: SquireItemAction,
    extra: {
      readonly text?: string | undefined;
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
        ...(extra.text === undefined ? {} : { text: extra.text }),
        ...(extra.answer === undefined ? {} : { answer: extra.answer }),
      },
    });
  return { canAct, run };
}

/** Marks the expanded or selected card opened, once per card per session. */
export function useSquireMarkOpened(
  environmentId: EnvironmentId,
  cardId: SquireCardId | null,
  openedAt: string | null | undefined,
) {
  const canMark = useAtomValue(squireEnvironment.itemsMarkOpened.permissionAtom(environmentId));
  const markOpened = useAtomCommand(squireEnvironment.itemsMarkOpened, { reportFailure: false });
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- sends the server a mark-opened request the first time this session shows a card
  useEffect(() => {
    if (cardId === null || !canMark) return;
    if (!squireOpenedThisSession.take(environmentId, cardId, openedAt)) return;
    void markOpened({
      environmentId,
      input: { requestId: randomUUID(), cardIds: [cardId] },
    }).then((result) => {
      if (result._tag === "Failure") squireOpenedThisSession.release(environmentId, cardId);
    });
  }, [environmentId, cardId, openedAt, canMark, markOpened]);
}
