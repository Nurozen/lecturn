export type NewTaskDraftRouteParams = {
  readonly requestId?: string;
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly title?: string | string[];
  readonly cloning?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function isDraftThreadRoute(
  route:
    | {
        readonly name: string;
        readonly params?: object;
      }
    | undefined,
) {
  return (
    route?.name === "Thread" && Boolean((route.params as { draft?: unknown } | undefined)?.draft)
  );
}

/**
 * `setParams` merges, so a thread selection clears what it does not name: a stale `accountId`
 * from a notification link would mark the next thread unavailable, and an unconsumed `prompt`
 * would fill the next thread's composer.
 */
export function threadRouteSelectionParams<Params extends object | undefined>(params: Params) {
  return {
    environmentId: undefined,
    threadId: undefined,
    draft: undefined,
    accountId: undefined,
    appId: undefined,
    prompt: undefined,
    ...params,
  };
}

export function submittedThreadParams(environmentId: string, threadId: string) {
  return threadRouteSelectionParams({ environmentId, threadId });
}

export function draftRouteIdentity(draft: NewTaskDraftRouteParams): string {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return JSON.stringify([
    draft.requestId,
    first(draft.pendingTaskId),
    first(draft.draftId),
    first(draft.environmentId),
    first(draft.projectId),
    draft.branch ?? null,
    draft.worktreePath ?? null,
    first(draft.incomingShareId),
  ]);
}
