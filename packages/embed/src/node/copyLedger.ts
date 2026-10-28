// @effect-diagnostics nodeBuiltinImport:off -- Promise API for hosts that run no Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ConnectedAppThreadSummary } from "@lecturn/contracts/apps";
import * as Schema from "effect/Schema";

type ThreadSummary = Pick<
  ConnectedAppThreadSummary,
  "threadId" | "historyRevision" | "state" | "copiedFrom" | "continuedIn"
>;

export interface ThreadCopy {
  readonly threadId: string;
  readonly sourceHistoryRevision: number;
}

/**
 * The user-server copy of each sidecar thread. A copy the user continued in
 * Lecturn is never replaced, so newer sidecar history lands as another copy
 * of the same source; the one taken at the highest revision is current.
 */
export function latestCopies(
  userThreads: ReadonlyArray<ThreadSummary>,
  sidecarEnvironmentId: string,
): Map<string, ThreadCopy> {
  const copies = new Map<string, ThreadCopy>();
  for (const thread of userThreads) {
    const origin = thread.copiedFrom;
    if (origin === undefined || origin.sourceEnvironmentId !== sidecarEnvironmentId) continue;
    const known = copies.get(origin.sourceThreadId);
    if (known === undefined || origin.sourceHistoryRevision > known.sourceHistoryRevision) {
      copies.set(origin.sourceThreadId, {
        threadId: thread.threadId,
        sourceHistoryRevision: origin.sourceHistoryRevision,
      });
    }
  }
  return copies;
}

/**
 * New threads, and threads with history newer than their copy. Only
 * `historyRevision` counts: subtitle and `continuedIn` writes move
 * `updatedAt` but are not history.
 */
export function threadsToCopy<T extends ThreadSummary>(
  sidecarThreads: ReadonlyArray<T>,
  copies: ReadonlyMap<string, ThreadCopy>,
): Array<T> {
  return sidecarThreads.filter((thread) => {
    const copy = copies.get(thread.threadId);
    return copy === undefined || copy.sourceHistoryRevision < thread.historyRevision;
  });
}

/** A turn waiting on an approval is still running; it can finish once the user answers. */
export const hasRunningTurn = (threads: ReadonlyArray<ThreadSummary>) =>
  threads.some((thread) => thread.state !== "idle");

/**
 * What the helper remembers in the sidecar's baseDir between runs: every
 * workspace it opened (a copy covers all of them, not only the ones open
 * now), and whether the sidecar may hold history no user server has yet,
 * which is what makes a later connect start the sidecar just to copy.
 */
export const AttachLedger = Schema.Struct({
  version: Schema.Literal(1),
  workspaces: Schema.Record(Schema.String, Schema.String),
  pendingCopy: Schema.Boolean,
});
export type AttachLedger = typeof AttachLedger.Type;

const decodeLedger = Schema.decodeUnknownOption(Schema.fromJsonString(AttachLedger));
const EMPTY_LEDGER: AttachLedger = { version: 1, workspaces: {}, pendingCopy: false };

const attachLedgerPath = (baseDir: string) => NodePath.join(baseDir, "embed-attach.json");

export async function readAttachLedger(baseDir: string): Promise<AttachLedger> {
  try {
    const decoded = decodeLedger(await NodeFSP.readFile(attachLedgerPath(baseDir), "utf8"));
    return decoded._tag === "Some" ? decoded.value : EMPTY_LEDGER;
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function writeAttachLedger(baseDir: string, ledger: AttachLedger): Promise<void> {
  const path = attachLedgerPath(baseDir);
  await NodeFSP.mkdir(baseDir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, JSON.stringify(ledger));
  await NodeFSP.rename(temp, path);
}
