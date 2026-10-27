/**
 * Pairs each connected-app tool approval with the row of the call it holds.
 *
 * The server orders turn items by when they first commit. The gate raises an
 * approval from inside the app tool's MCP call, which reaches the server apart
 * from the provider's own event stream, so the approval often commits before
 * the call's row and sorts above the call it is holding. The server cannot
 * place it: the MCP request carries no provider call id, and the call's row may
 * not exist yet when the gate raises the approval. The request names only the
 * tool, so each approval claims a call of that tool in its own run here.
 */
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RuntimeRequestId,
} from "@lecturn/contracts";
import { isAppToolSource } from "@lecturn/shared/appToolPresentation";
import { lecturnMcpToolName } from "@lecturn/shared/lecturnMcpToolName";
import * as DateTime from "effect/DateTime";

type VisibleRows = OrchestrationV2ThreadProjection["visibleTurnItems"];
type RuntimeRequests = OrchestrationV2ThreadProjection["runtimeRequests"];

export interface AppToolApproval {
  readonly requestId: RuntimeRequestId;
  /** As the gate names it (`rw_simulate`), whatever the provider recorded on the call. */
  readonly toolName: string;
  readonly pending: boolean;
}

export interface HeldAppToolCall {
  readonly requestId: RuntimeRequestId;
  /** -1 when the approval's own row is not among the rows. */
  readonly approvalIndex: number;
  readonly callIndex: number;
}

const UNFINISHED: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

function appToolCallName(item: OrchestrationV2TurnItem): string | undefined {
  if (item.type !== "dynamic_tool" || !isAppToolSource(item.toolSource) || item.toolName === null) {
    return undefined;
  }
  return lecturnMcpToolName(item.toolName) ?? item.toolName;
}

/**
 * The gate blocks its call until the answer. A waiting approval can only hold a
 * call that is still running; an answered one let its call go on, but never held
 * a call that had already ended when it was raised.
 */
function couldBeHeld(
  call: OrchestrationV2TurnItem,
  approval: AppToolApproval,
  approvalItem: OrchestrationV2TurnItem | undefined,
): boolean {
  if (UNFINISHED.has(call.status)) return true;
  if (approval.pending || approvalItem === undefined || call.completedAt === null) return false;
  const raisedAt = approvalItem.startedAt ?? approvalItem.updatedAt;
  return DateTime.toEpochMillis(call.completedAt) >= DateTime.toEpochMillis(raisedAt);
}

/**
 * Each approval, in order, claims an unclaimed call of its tool in its run: the
 * latest before its row, else the first after it.
 */
function claimHeldAppToolCalls<Row>(
  rows: ReadonlyArray<Row>,
  approvals: ReadonlyArray<AppToolApproval>,
  itemOf: (row: Row) => OrchestrationV2TurnItem | undefined,
): ReadonlyArray<HeldAppToolCall> {
  if (approvals.length === 0) return [];
  const requestIds = new Set<string>(approvals.map((approval) => approval.requestId));
  const approvalIndexes = new Map<string, number>();
  const callIndexesByTool = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const item = itemOf(row);
    if (item === undefined) continue;
    if (item.type === "approval_request") {
      if (requestIds.has(item.requestId)) approvalIndexes.set(item.requestId, index);
      continue;
    }
    const toolName = appToolCallName(item);
    if (toolName === undefined) continue;
    const calls = callIndexesByTool.get(toolName);
    if (calls === undefined) callIndexesByTool.set(toolName, [index]);
    else calls.push(index);
  }

  const claimed = new Set<number>();
  const held: HeldAppToolCall[] = [];
  for (const approval of approvals) {
    const calls = callIndexesByTool.get(approval.toolName);
    if (calls === undefined) continue;
    const approvalIndex = approvalIndexes.get(approval.requestId) ?? -1;
    const approvalItem = approvalIndex === -1 ? undefined : itemOf(rows[approvalIndex]!);
    const runId = approvalItem?.runId ?? null;
    const canClaim = (index: number) => {
      if (claimed.has(index)) return false;
      const call = itemOf(rows[index]!)!;
      return (runId === null || call.runId === runId) && couldBeHeld(call, approval, approvalItem);
    };
    const end = approvalIndex === -1 ? rows.length : approvalIndex;
    let callIndex: number | undefined;
    for (let at = calls.length - 1; at >= 0 && callIndex === undefined; at -= 1) {
      if (calls[at]! < end && canClaim(calls[at]!)) callIndex = calls[at];
    }
    for (let at = 0; at < calls.length && callIndex === undefined; at += 1) {
      if (calls[at]! > end && canClaim(calls[at]!)) callIndex = calls[at];
    }
    if (callIndex === undefined) continue;
    claimed.add(callIndex);
    held.push({ requestId: approval.requestId, approvalIndex, callIndex });
  }
  return held;
}

/** An approval the composer's card is asking; an app's names the tool whose call it holds. */
export interface CardApproval {
  readonly requestId: RuntimeRequestId;
  readonly connectedAppTool?: { readonly toolName: string };
}

/**
 * The rows beside the composer's approval card. A waiting app approval's own row repeats the card
 * word for word, and the call it holds is not running but waiting on the card, so both stay out
 * until it is answered; then the call comes back with its approval below it. A provider's own
 * waiting approval row stays unless `hideProviderApprovals`, since its card shows the command under
 * a generic title.
 */
export function withoutApprovalCardRows<Row>(
  rows: ReadonlyArray<Row>,
  approvals: ReadonlyArray<CardApproval>,
  itemOf: (row: Row) => OrchestrationV2TurnItem | undefined,
  options?: { readonly hideProviderApprovals?: boolean },
): ReadonlyArray<Row> {
  const hidden =
    options?.hideProviderApprovals === true
      ? approvals
      : approvals.filter((approval) => approval.connectedAppTool !== undefined);
  if (hidden.length === 0) return rows;
  const appApprovals = hidden.flatMap((approval) =>
    approval.connectedAppTool === undefined
      ? []
      : [
          {
            requestId: approval.requestId,
            toolName: approval.connectedAppTool.toolName,
            pending: true,
          },
        ],
  );
  const heldCalls = new Set(
    claimHeldAppToolCalls(rows, appApprovals, itemOf).map((held) => held.callIndex),
  );
  const asked = new Set<string>(hidden.map((approval) => approval.requestId));
  const kept = rows.filter((row, index) => {
    if (heldCalls.has(index)) return false;
    const item = itemOf(row);
    return item?.type !== "approval_request" || !asked.has(item.requestId);
  });
  return kept.length === rows.length ? rows : kept;
}

export function appToolApprovalsOf(requests: RuntimeRequests): ReadonlyArray<AppToolApproval> {
  return requests.flatMap((request) =>
    request.connectedAppTool === undefined
      ? []
      : [
          {
            requestId: request.id,
            toolName: request.connectedAppTool.toolName,
            pending: request.status === "pending",
          },
        ],
  );
}

/**
 * Moves each app approval that sorts above the call it holds to just below that
 * call, waiting or answered, so answering it does not move the row. Rows keep
 * their objects and positions, so caches keyed by row identity still hit.
 */
export function placeAppToolApprovals(
  rows: VisibleRows,
  approvals: ReadonlyArray<AppToolApproval>,
): VisibleRows {
  const approvalBelowCall = new Map<number, number>();
  for (const held of claimHeldAppToolCalls(rows, approvals, (row) => row.item)) {
    if (held.approvalIndex !== -1 && held.approvalIndex < held.callIndex) {
      approvalBelowCall.set(held.callIndex, held.approvalIndex);
    }
  }
  if (approvalBelowCall.size === 0) return rows;
  const moved = new Set(approvalBelowCall.values());
  const placed: Array<VisibleRows[number]> = [];
  for (const [index, row] of rows.entries()) {
    if (moved.has(index)) continue;
    placed.push(row);
    const approvalIndex = approvalBelowCall.get(index);
    if (approvalIndex !== undefined) placed.push(rows[approvalIndex]!);
  }
  return placed;
}

/** Memoized `placeAppToolApprovals` over a projection's rows and requests. */
export function createAppToolApprovalPlacer() {
  let previousRequests: RuntimeRequests | undefined;
  let approvals: ReadonlyArray<AppToolApproval> = [];
  let previousRows: VisibleRows | undefined;
  let previousResult: VisibleRows | undefined;
  return (rows: VisibleRows, requests: RuntimeRequests): VisibleRows => {
    if (requests !== previousRequests) {
      previousRequests = requests;
      approvals = appToolApprovalsOf(requests);
      previousRows = undefined;
    }
    if (approvals.length === 0) return rows;
    if (rows !== previousRows || previousResult === undefined) {
      previousRows = rows;
      previousResult = placeAppToolApprovals(rows, approvals);
    }
    return previousResult;
  };
}
