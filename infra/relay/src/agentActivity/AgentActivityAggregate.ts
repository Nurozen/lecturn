import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@lecturn/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  MAX_ACTIVITY_ROWS,
  sanitizeAgentActivityAggregateState,
  statusForAgentActivity,
} from "./agentActivityPayloads.ts";

function aggregateRowForState(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForAgentActivity(state),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
    ...(state.pullRequest ? { pullRequest: state.pullRequest } : {}),
  };
}

function terminalAggregateState(state: RelayAgentActivityState): RelayAgentActivityAggregateState {
  return sanitizeAgentActivityAggregateState({
    title: "Lecturn",
    subtitle: state.pullRequest
      ? `Pull request ${state.pullRequest.state}`
      : state.phase === "failed"
        ? "Agent work failed"
        : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state)],
  });
}

// How long a finished thread keeps its Done/Failed row in the aggregate while
// other agents are still active. Long enough to be seen on the lock screen,
// short enough that the activity list stays about live work.
export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.activeStates.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return terminalAggregateState(input.terminalState);
    }
    // With no live work, recently finished threads keep the card showing
    // Done/Failed content (an armed card never renders an empty state). The
    // newly-terminal alert rules key off the previously delivered aggregate,
    // so replays repaint this without buzzing. Once the terminal rows age
    // out, the aggregate is null and the delivery layer ends the card.
    const recentTerminal = input.activeStates
      .filter((state) => isRecentTerminalState(state, input.nowMs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = recentTerminal[0];
    if (!newest) {
      return null;
    }
    return sanitizeAgentActivityAggregateState({
      title: "Lecturn",
      subtitle: newest.pullRequest
        ? `Pull request ${newest.pullRequest.state}`
        : newest.phase === "failed"
          ? "Agent work failed"
          : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
    });
  }
  // Recently finished threads ride along after the active ones (display slots
  // permitting) so a completion is visible as Done/Failed instead of the row
  // silently vanishing while other agents keep the activity alive.
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const displayedStates = [
    ...activeStates.slice(0, MAX_ACTIVITY_ROWS),
    ...recentTerminalStates,
  ].slice(0, MAX_ACTIVITY_ROWS);
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "Lecturn",
    subtitle: activeStates.some((state) => state.pullRequest)
      ? "Agents and pull requests"
      : "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}
