// @effect-diagnostics nodeBuiltinImport:off -- durable deterministic identity and request fingerprints
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@lecturn/shared/relaySigning";
import { forkParked } from "../serverActivation.ts";
import {
  PullRequestWatch as WatchSchema,
  PullRequestWatchError,
  PullRequestWatchMergeMode,
  type PullRequestWatch,
  type PullRequestWatchCommandInput,
  type PullRequestWatchConfigureInput,
  type PullRequestWatchListInput,
  type PullRequestWatchSnapshot,
  type PullRequestWatchTrackInput,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore, type Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { PullRequestWatchProvider } from "./PullRequestWatchProvider.ts";
import {
  loadWatchSagaRosters,
  mergeDecision,
  projectContainsWatch,
} from "./PullRequestWatchPolicy.ts";
import { StaveRpcRuntime } from "../stave/staveRpcHandlers.ts";

const Stored = Schema.Struct({
  watch: WatchSchema,
  revokePending: Schema.Boolean,
});
type Stored = typeof Stored.Type;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Stored));
const encode = Schema.encodeEffect(Schema.fromJsonString(Stored));
const encodeWatch = Schema.encodeEffect(Schema.fromJsonString(WatchSchema));
const decodeWatch = Schema.decodeUnknownEffect(Schema.fromJsonString(WatchSchema));
const fingerprint = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const fail = (message: string, code: PullRequestWatchError["code"] = "unavailable") =>
  new PullRequestWatchError({ code, message });
const isWatchError = Schema.is(PullRequestWatchError);
const decodeMode = Schema.decodeUnknownEffect(PullRequestWatchMergeMode);
const completionAfterObservation = (
  watch: PullRequestWatch,
  observation: NonNullable<PullRequestWatch["observation"]>,
  at: string,
): string | null =>
  observation.state === "open"
    ? null
    : watch.observation?.state === "open"
      ? at
      : (watch.completedAt ?? null);

const boundary = (error: unknown) =>
  isWatchError(error) ? error : fail("Pull request watch information is currently unavailable.");
export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  {
    readonly list: (
      input: PullRequestWatchListInput,
    ) => Effect.Effect<PullRequestWatchSnapshot, PullRequestWatchError>;
    readonly track: (
      input: PullRequestWatchTrackInput,
      actor: string,
    ) => Effect.Effect<PullRequestWatch, PullRequestWatchError>;
    readonly command: (
      input: PullRequestWatchCommandInput,
      actor: string,
    ) => Effect.Effect<PullRequestWatch, PullRequestWatchError>;
    readonly configure: (
      input: PullRequestWatchConfigureInput,
    ) => Effect.Effect<PullRequestWatchSnapshot, PullRequestWatchError>;
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("lecturn/pullRequest/PullRequestWatchService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* PullRequestWatchProvider;
  const projections = yield* ProjectionSnapshotQuery;
  const staveRuntime = yield* Effect.serviceOption(StaveRpcRuntime);
  const background = yield* Effect.serviceOption(ThreadBackgroundLivenessService);
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const lock = (key: string) => ({
    withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let entry = locks.get(key);
        if (!entry) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, entry);
        }
        const current = entry;
        current.users++;
        return current.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current.users--;
              if (current.users === 0) locks.delete(key);
            }),
          ),
        );
      }),
  });
  const get = Effect.fn("PullRequestWatch.get")(function* (id: string) {
    const rows = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM pull_request_watches WHERE id = ${id}`;
    return rows[0] ? yield* decode(rows[0].state_json) : null;
  }, Effect.mapError(boundary));
  const save = Effect.fn("PullRequestWatch.save")(function* (state: Stored) {
    const watch = { ...state.watch, revision: state.watch.revision + 1, updatedAt: yield* now };
    const next = { ...state, watch };
    yield* sql`INSERT INTO pull_request_watches(id, project_id, state_json) VALUES (${watch.id}, ${watch.reference.projectId}, ${yield* encode(next)}) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`;
    return next;
  }, Effect.mapError(boundary));
  const all = Effect.fn("PullRequestWatch.all")(function* () {
    const rows = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM pull_request_watches ORDER BY id`;
    return yield* Effect.forEach(rows, (row) => decode(row.state_json));
  }, Effect.mapError(boundary));
  const defaultMode = Effect.fn("PullRequestWatch.defaultMode")(function* () {
    const rows = yield* sql<{
      mode: string;
    }>`SELECT mode FROM pull_request_watch_settings WHERE id = 1`;
    return yield* decodeMode(rows[0]?.mode ?? "follow-pr");
  }, Effect.mapError(boundary));
  const managerStatus = Effect.fn("PullRequestWatch.managerStatus")(function* (
    watch: PullRequestWatch,
  ) {
    if (!watch.managerThreadId) return "unassigned" as const;
    const manager = yield* projections.getThreadShellById(watch.managerThreadId);
    if (Option.isNone(manager)) return "offline" as const;
    const projects = (yield* projections.getShellSnapshot()).projects;
    if (
      manager.value.projectId !== watch.reference.projectId &&
      !projectContainsWatch(
        manager.value.projectId,
        watch.reference.projectId,
        projects,
        manager.value.worktreePath,
        watch.reference,
        yield* loadWatchSagaRosters(projects, staveRuntime),
        watch.binding,
      )
    )
      return "offline" as const;
    const session = manager.value.session;
    if (!session || ["stopped", "error", "interrupted"].includes(session.status))
      return "offline" as const;
    const live = Option.isSome(background)
      ? background.value.getThreadBackgroundLiveness(watch.managerThreadId)
      : manager.value.backgroundLiveness;
    if (session.activeTurnId || session.status === "running" || live === "working")
      return "working" as const;
    return live === "monitoring" ? ("monitoring" as const) : ("idle" as const);
  }, Effect.mapError(boundary));
  const present = Effect.fn("PullRequestWatch.present")(function* (watch: PullRequestWatch) {
    return { ...watch, managerStatus: yield* managerStatus(watch) };
  });
  const list = Effect.fn("PullRequestWatch.list")(function* (input: PullRequestWatchListInput) {
    const states = yield* all();
    return {
      watches: yield* Effect.forEach(
        states.filter(
          ({ watch }) => !input.projectIds || input.projectIds.includes(watch.reference.projectId),
        ),
        ({ watch }) => present(watch),
      ),
      defaultMergeMode: yield* defaultMode(),
    };
  }, Effect.mapError(boundary));
  const validateThread = Effect.fn("PullRequestWatch.validateThread")(function* (
    threadId: ThreadId,
    reference: PullRequestWatch["reference"],
    binding?: string,
  ) {
    const thread = yield* projections.getThreadShellById(threadId);
    const projects = (yield* projections.getShellSnapshot()).projects;
    if (
      Option.isNone(thread) ||
      (thread.value.projectId !== reference.projectId &&
        !projectContainsWatch(
          thread.value.projectId,
          reference.projectId,
          projects,
          thread.value.worktreePath,
          reference,
          yield* loadWatchSagaRosters(projects, staveRuntime),
          binding,
        ))
    )
      return yield* fail(
        "The managing or associated thread must belong to this project or its saga.",
        "invalid",
      );
  }, Effect.mapError(boundary));
  const receipt = Effect.fn("PullRequestWatch.receipt")(function* (
    actor: string,
    requestId: string,
    hash: string,
  ) {
    const rows = yield* sql<{
      request_hash: string;
      watch_id: string | null;
      result_json: string | null;
    }>`SELECT request_hash, watch_id, result_json FROM pull_request_watch_receipts WHERE actor = ${actor} AND request_id = ${requestId}`;
    const row = rows[0];
    if (row && row.request_hash !== hash)
      return yield* fail("This request ID was already used for a different command.", "conflict");
    return row ?? null;
  }, Effect.mapError(boundary));
  const complete = Effect.fn("PullRequestWatch.complete")(function* (
    actor: string,
    requestId: string,
    watch: PullRequestWatch,
  ) {
    yield* sql`UPDATE pull_request_watch_receipts SET result_json = ${yield* encodeWatch(watch)} WHERE actor = ${actor} AND request_id = ${requestId}`;
    return yield* present(watch);
  }, Effect.mapError(boundary));

  const recoverBinding = Effect.fn("PullRequestWatch.recoverBinding")(function* (
    state: Stored,
    fresh: {
      readonly reference: PullRequestWatch["reference"];
      readonly binding: string;
      readonly observation: NonNullable<PullRequestWatch["observation"]>;
    },
  ) {
    const previous = state.watch.reference;
    if (
      !previous.host ||
      !fresh.reference.host ||
      previous.projectId !== fresh.reference.projectId ||
      previous.host.toLowerCase() !== fresh.reference.host.toLowerCase() ||
      previous.repository.toLowerCase() !== fresh.reference.repository.toLowerCase() ||
      previous.number !== fresh.reference.number
    )
      return yield* fail(
        "The pull request identity changed. Track the new pull request separately.",
        "conflict",
      );
    if (fresh.observation.state === "open" && fresh.observation.autoMergeEnabled !== false)
      return yield* fail(
        "The repository binding changed and provider auto-merge is enabled or unknown. Open this pull request in the provider, disable auto-merge, then resume watching.",
        "conflict",
      );
    return {
      revokePending: false,
      watch: {
        ...state.watch,
        reference: fresh.reference,
        binding: fresh.binding,
        observation: fresh.observation,
        authorization: null,
        completedAt: null,
        managerThreadId: null,
        managerStatus: "unassigned" as const,
        threadIds: [],
        watching: fresh.observation.state === "open",
        lastAttemptAt: yield* now,
        error: null,
      },
    };
  });

  const reconcile = Effect.fn("PullRequestWatch.reconcile")(function* (
    initial: Stored,
    allowBindingRecovery = false,
  ) {
    let state = initial;
    const attemptAt = yield* now;
    const operation = Effect.gen(function* () {
      const fresh = yield* provider.observe(state.watch.reference);
      if (fresh.binding !== state.watch.binding && allowBindingRecovery) {
        state = {
          ...state,
          watch: {
            ...state.watch,
            watching: false,
            authorization: state.watch.authorization
              ? {
                  ...state.watch.authorization,
                  status: "needs-authorization",
                  message:
                    "Repository binding changed. Recover tracking before authorizing merging again.",
                }
              : null,
          },
        };
        state = yield* save(yield* recoverBinding(state, fresh));
      }
      if (fresh.binding !== state.watch.binding) {
        state = yield* save({
          ...state,
          watch: {
            ...state.watch,
            watching: false,
            authorization: state.watch.authorization
              ? {
                  ...state.watch.authorization,
                  status: "needs-authorization",
                  message:
                    "The project repository binding changed. Resume watching to verify the new binding before authorizing merging again.",
                }
              : null,
            error: "Repository binding changed; previous merge authorization is no longer valid.",
            lastAttemptAt: attemptAt,
          },
        });
        return yield* fail(state.watch.error!);
      }
      state = {
        ...state,
        watch: {
          ...state.watch,
          observation: fresh.observation,
          completedAt: completionAfterObservation(state.watch, fresh.observation, attemptAt),
          reference: fresh.reference,
          lastAttemptAt: attemptAt,
          error: null,
        },
      };
      const auth = state.watch.authorization;
      const invalidated =
        auth &&
        (auth.baseBranch !== fresh.observation.baseBranch ||
          (auth.mode === "revision-only" && auth.headRevision !== fresh.observation.headRevision));
      if (invalidated)
        state = {
          ...state,
          revokePending: true,
          watch: {
            ...state.watch,
            authorization: {
              ...auth,
              status: "needs-authorization",
              message: "The authorized target or revision changed. Authorize merging again.",
            },
          },
        };
      if (state.watch.authorization && fresh.observation.autoMergeEnabled === true)
        state = { ...state, revokePending: true };
      // Save revocation intent before crossing the provider boundary, including mode changes.
      if (state.revokePending) {
        state = yield* save(state);
        if (fresh.observation.state === "open" && fresh.observation.autoMergeEnabled !== false) {
          yield* provider.runAction({
            ...state.watch.reference,
            action: "disable-auto-merge",
            expectedBinding: state.watch.binding,
          });
          const disabled = yield* provider.observe(state.watch.reference);
          if (
            disabled.binding !== state.watch.binding ||
            disabled.observation.autoMergeEnabled !== false
          )
            return yield* fail(
              "Provider auto-merge has not yet been confirmed disabled. Revocation will be retried.",
            );
          state = {
            ...state,
            watch: {
              ...state.watch,
              observation: disabled.observation,
              completedAt: completionAfterObservation(
                state.watch,
                disabled.observation,
                yield* now,
              ),
            },
          };
        }
        state = yield* save({ ...state, revokePending: false });
      }
      const decision = mergeDecision(state.watch);
      state = yield* save({
        ...state,
        watch: {
          ...state.watch,
          authorization: decision.authorization,
          watching: state.watch.watching && state.watch.observation?.state === "open",
        },
      });
      if (decision.action) {
        yield* provider.runAction({
          ...state.watch.reference,
          action: decision.action,
          mergeMethod: decision.authorization!.mergeMethod,
          expectedHeadRevision: state.watch.observation!.headRevision!,
          expectedBaseBranch: decision.authorization!.baseBranch,
          expectedBinding: state.watch.binding,
        });
        const confirmation = yield* provider.observe(state.watch.reference);
        if (confirmation.binding !== state.watch.binding)
          return yield* fail("Repository binding changed while confirming the merge action.");
        state = {
          ...state,
          watch: {
            ...state.watch,
            observation: confirmation.observation,
            completedAt: completionAfterObservation(
              state.watch,
              confirmation.observation,
              yield* now,
            ),
          },
        };
        const confirmed = mergeDecision(state.watch);
        state = yield* save({
          ...state,
          watch: {
            ...state.watch,
            authorization: confirmed.authorization,
            watching: state.watch.watching && confirmation.observation.state === "open",
          },
        });
        if (confirmation.observation.state !== "merged")
          return yield* fail(
            "The provider has not yet confirmed the merge action. Tracking will reconcile its state.",
          );
      }
      return state;
    });
    return yield* operation.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          state = yield* save({
            ...state,
            watch: { ...state.watch, lastAttemptAt: attemptAt, error: boundary(error).message },
          });
          return yield* boundary(error);
        }),
      ),
    );
  });

  const track = Effect.fn("PullRequestWatch.track")(function* (
    input: PullRequestWatchTrackInput,
    actor: string,
  ) {
    const hash = fingerprint(["track", input]);
    return yield* lock(`request:${actor}:${input.requestId}`).withPermit(
      Effect.gen(function* () {
        const prior = yield* receipt(actor, input.requestId, hash);
        if (prior?.result_json) return yield* present(yield* decodeWatch(prior.result_json));
        if (input.manage && !input.threadId)
          return yield* fail("Choose a thread to manage this pull request.", "invalid");
        const fresh = yield* provider.observe(input.reference);
        if (input.threadId) yield* validateThread(input.threadId, fresh.reference, fresh.binding);
        const id = fingerprint([
          fresh.reference.projectId,
          fresh.reference.host?.toLowerCase(),
          fresh.reference.repository.toLowerCase(),
          fresh.reference.number,
        ]);
        return yield* lock(id).withPermit(
          Effect.gen(function* () {
            const current = yield* get(id);
            const at = yield* now;
            const recovered =
              current && current.watch.binding !== fresh.binding
                ? yield* recoverBinding(current, fresh)
                : current;
            const existing = recovered?.watch;
            const watch: PullRequestWatch = existing
              ? {
                  ...existing,
                  reference: fresh.reference,
                  binding: fresh.binding,
                  observation:
                    existing.binding === fresh.binding ? existing.observation : fresh.observation,
                  error: existing.binding === fresh.binding ? existing.error : null,
                  ...(input.threadId
                    ? { threadIds: [...new Set([...existing.threadIds, input.threadId])] }
                    : {}),
                  ...(input.manage ? { managerThreadId: input.threadId! } : {}),
                }
              : {
                  id,
                  reference: fresh.reference,
                  binding: fresh.binding,
                  watching: fresh.observation.state === "open",
                  revision: 0,
                  threadIds: input.threadId ? [input.threadId] : [],
                  managerThreadId: input.manage ? input.threadId! : null,
                  managerStatus: "unassigned",
                  observation: fresh.observation,
                  authorization: null,
                  completedAt: null,
                  lastAttemptAt: at,
                  error: null,
                  createdAt: at,
                  updatedAt: at,
                };
            const saved = yield* sql.withTransaction(
              Effect.gen(function* () {
                const next = yield* save({
                  watch,
                  revokePending: recovered?.revokePending ?? false,
                });
                yield* sql`INSERT INTO pull_request_watch_receipts(actor, request_id, request_hash, watch_id, result_json) VALUES (${actor}, ${input.requestId}, ${hash}, ${id}, ${yield* encodeWatch(next.watch)})`;
                return next.watch;
              }),
            );
            return yield* present(saved);
          }),
        );
      }),
    );
  }, Effect.mapError(boundary));

  const command = Effect.fn("PullRequestWatch.command")(function* (
    input: PullRequestWatchCommandInput,
    actor: string,
  ) {
    const hash = fingerprint(["command", input]);
    return yield* lock(`request:${actor}:${input.requestId}`).withPermit(
      lock(input.watchId).withPermit(
        Effect.gen(function* () {
          const prior = yield* receipt(actor, input.requestId, hash);
          if (prior?.result_json) return yield* present(yield* decodeWatch(prior.result_json));
          let state = yield* get(input.watchId);
          if (!state) return yield* fail("This pull request watch does not exist.", "not-found");
          if (!prior) {
            const watch = state.watch;
            if (input.action === "set-manager") {
              if (input.managerThreadId === undefined)
                return yield* fail("Choose a manager or explicitly clear it.", "invalid");
              if (input.managerThreadId)
                yield* validateThread(input.managerThreadId, watch.reference, watch.binding);
              state = { ...state, watch: { ...watch, managerThreadId: input.managerThreadId } };
            } else if (input.action === "pause" || input.action === "revoke-merge") {
              state = {
                ...state,
                revokePending:
                  state.revokePending ||
                  watch.authorization !== null ||
                  watch.observation?.autoMergeEnabled === true,
                watch: {
                  ...watch,
                  authorization: null,
                  watching: input.action === "pause" ? false : watch.watching,
                },
              };
            } else if (input.action === "resume") {
              state = { ...state, watch: { ...watch, watching: true } };
            } else if (input.action === "authorize-merge") {
              const fresh = yield* provider.observe(watch.reference);
              if (fresh.binding !== watch.binding)
                return yield* fail(
                  "The repository binding changed. Track the current repository before authorizing merging.",
                  "conflict",
                );
              if (fresh.observation.state !== "open")
                return yield* fail(
                  "Only open pull requests can be authorized for merging.",
                  "invalid",
                );
              if (
                (input.expectedBinding !== undefined && input.expectedBinding !== fresh.binding) ||
                (input.expectedBaseBranch !== undefined &&
                  input.expectedBaseBranch !== fresh.observation.baseBranch) ||
                (input.expectedHeadRevision !== undefined &&
                  input.expectedHeadRevision !== fresh.observation.headRevision)
              )
                return yield* fail(
                  "The pull request changed after confirmation. Review its current target and revision before authorizing merging.",
                  "conflict",
                );
              const mode = input.mergeMode ?? (yield* defaultMode());
              if (
                mode === "revision-only" &&
                (!fresh.observation.headRevision ||
                  input.expectedHeadRevision !== fresh.observation.headRevision)
              )
                return yield* fail(
                  "The current revision must match the revision you authorize.",
                  "conflict",
                );
              state = {
                ...state,
                revokePending:
                  state.revokePending ||
                  fresh.observation.autoMergeEnabled !== false ||
                  (watch.authorization !== null &&
                    watch.authorization.mergeMethod !== (input.mergeMethod ?? "squash")),
                watch: {
                  ...watch,
                  watching: true,
                  observation: fresh.observation,
                  error: null,
                  authorization: {
                    mode,
                    headRevision: mode === "revision-only" ? fresh.observation.headRevision : null,
                    baseBranch: fresh.observation.baseBranch,
                    mergeMethod: input.mergeMethod ?? "squash",
                    authorizedAt: yield* now,
                    authorizedBy: actor,
                    status: "waiting",
                    message: null,
                  },
                },
              };
            }
            const staged = state;
            state = yield* sql.withTransaction(
              Effect.gen(function* () {
                const next = yield* save(staged);
                yield* sql`INSERT INTO pull_request_watch_receipts(actor, request_id, request_hash, watch_id, result_json) VALUES (${actor}, ${input.requestId}, ${hash}, ${input.watchId}, NULL)`;
                return next;
              }),
            );
          }
          if (input.action !== "set-manager")
            state = yield* reconcile(state, input.action === "resume");
          return yield* complete(actor, input.requestId, state.watch);
        }),
      ),
    );
  }, Effect.mapError(boundary));

  const configure = Effect.fn("PullRequestWatch.configure")(function* (
    input: PullRequestWatchConfigureInput,
  ) {
    yield* sql`UPDATE pull_request_watch_settings SET mode = ${input.defaultMergeMode} WHERE id = 1`;
    return yield* list({});
  }, Effect.mapError(boundary));
  const tick = Effect.gen(function* () {
    const shell = yield* projections.getShellSnapshot();
    const rosters = yield* loadWatchSagaRosters(shell.projects, staveRuntime);
    const states = yield* all();
    for (const thread of shell.threads) {
      const reference = thread.linkedPullRequest;
      if (
        !reference ||
        !projectContainsWatch(
          thread.projectId,
          reference.projectId,
          shell.projects,
          thread.worktreePath,
          undefined,
          rosters,
        )
      )
        continue;
      const existing = states.find(
        ({ watch }) =>
          watch.reference.projectId === reference.projectId &&
          watch.reference.repository.toLowerCase() === reference.repository.toLowerCase() &&
          watch.reference.number === reference.number &&
          (reference.host === undefined ||
            watch.reference.host?.toLowerCase() === reference.host.toLowerCase()),
      )?.watch;
      if (existing?.threadIds.includes(thread.id)) continue;
      yield* track(
        {
          requestId: `linked:${fingerprint([thread.id, reference, existing?.binding, existing?.revision])}`,
          reference,
          threadId: thread.id,
        },
        "system:linked-pr",
      ).pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    }
    for (const { watch } of yield* all()) {
      yield* lock(watch.id)
        .withPermit(
          Effect.gen(function* () {
            const state = yield* get(watch.id);
            if (state && (state.watch.watching || state.revokePending)) yield* reconcile(state);
          }),
        )
        .pipe(Effect.catch((error) => Effect.logWarning(boundary(error).message)));
    }
  }).pipe(Effect.catch((error) => Effect.logWarning(boundary(error).message)));
  let started = false;
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        started = false;
      }),
    );
    yield* tick.pipe(Effect.andThen(Effect.sleep("30 seconds")), Effect.forever, forkParked);
  });
  return PullRequestWatchService.of({ list, track, command, configure, tick, start });
});
export const layer = Layer.effect(PullRequestWatchService, make);
