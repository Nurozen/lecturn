import type { OrchestrationV2ProjectedTurnItem } from "@lecturn/contracts";
import {
  appReferenceLabelsFromRecords,
  type AppReferenceLabel,
} from "@lecturn/shared/appReferences";
import { useEffect } from "react";
import { create } from "zustand";

import { useAppReferences, type DescribeAppReferences } from "./AppReferencesContext";

type LabelsByRef = Readonly<Record<string, string>>;
/** Null: the app was asked and has no name for it, so the chip shows the reference. */
type DescribedByRef = Readonly<Record<string, string | null>>;

interface AppRefLabelState {
  /** Names the user's chips carried, from the thread's messages and this tab's sends, by thread. */
  readonly stored: Readonly<Record<string, LabelsByRef>>;
  /** What the embed's host answered for references no message named, by thread. */
  readonly described: Readonly<Record<string, DescribedByRef>>;
  readonly remember: (scope: string, labels: ReadonlyArray<AppReferenceLabel>) => void;
  readonly setDescribed: (scope: string, described: DescribedByRef) => void;
}

const EMPTY: LabelsByRef = {};

export const useAppRefLabelStore = create<AppRefLabelState>()((set) => ({
  stored: {},
  described: {},
  remember: (scope, labels) =>
    set((state) => {
      const current = state.stored[scope] ?? EMPTY;
      const added = labels.filter(({ ref, label }) => current[ref] !== label);
      if (added.length === 0) return state;
      const next = { ...current };
      for (const { ref, label } of added) next[ref] = label;
      return { stored: { ...state.stored, [scope]: next } };
    }),
  setDescribed: (scope, described) =>
    set((state) => ({
      described: { ...state.described, [scope]: { ...state.described[scope], ...described } },
    })),
}));

/** The labels the user's sent chips stored on a thread's visible messages. */
export function storedAppRefLabels(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): AppReferenceLabel[] {
  return items.flatMap(({ item }) =>
    item.type === "user_message" && item.context !== undefined
      ? appReferenceLabelsFromRecords(item.context.records)
      : [],
  );
}

const queued = new Map<string, { describe: DescribeAppReferences; refs: Set<string> }>();
const inFlight = new Map<string, Set<string>>();
let flushScheduled = false;

const isKnown = (scope: string, ref: string) => {
  const state = useAppRefLabelStore.getState();
  return state.stored[scope]?.[ref] !== undefined || state.described[scope]?.[ref] !== undefined;
};

function flush() {
  flushScheduled = false;
  const batches = [...queued];
  queued.clear();
  for (const [scope, { describe, refs }] of batches) {
    const asking = inFlight.get(scope) ?? new Set<string>();
    const missing = [...refs].filter((ref) => !asking.has(ref) && !isKnown(scope, ref));
    if (missing.length === 0) continue;
    for (const ref of missing) asking.add(ref);
    inFlight.set(scope, asking);
    const settle = (labels: Readonly<Record<string, string>>) => {
      for (const ref of missing) asking.delete(ref);
      useAppRefLabelStore
        .getState()
        .setDescribed(scope, Object.fromEntries(missing.map((ref) => [ref, labels[ref] ?? null])));
    };
    // An app that cannot answer leaves its references as they are written.
    describe(missing).then(settle, () => settle({}));
  }
}

/** Every chip a render shows asks in the same tick, so the host gets one request per thread. */
function requestAppRefLabel(scope: string, ref: string, describe: DescribeAppReferences) {
  const batch = queued.get(scope) ?? { describe, refs: new Set<string>() };
  batch.refs.add(ref);
  queued.set(scope, batch);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/**
 * What a reference chip in a message says: the name its chip carried when the user sent it, else
 * the embed host's name for it, else the reference itself.
 */
export function useAppRefLabel(ref: string, enabled = true): string {
  const appReferences = useAppReferences();
  const scope = enabled ? (appReferences?.labelScope ?? null) : null;
  const describe = appReferences?.describe ?? null;
  const stored = useAppRefLabelStore((state) =>
    scope === null ? undefined : state.stored[scope]?.[ref],
  );
  const described = useAppRefLabelStore((state) =>
    scope === null ? undefined : state.described[scope]?.[ref],
  );
  const unknown = stored === undefined && described === undefined;
  useEffect(() => {
    if (scope !== null && describe !== null && unknown) requestAppRefLabel(scope, ref, describe);
  }, [scope, ref, describe, unknown]);
  return stored ?? described ?? ref;
}

export function __resetAppRefLabelsForTests(): void {
  queued.clear();
  inFlight.clear();
  flushScheduled = false;
  useAppRefLabelStore.setState({ stored: {}, described: {} });
}
