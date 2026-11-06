/**
 * The Lead's first run: `open` enqueues one `onboarding`
 * event with a bounded scan of the environment and captures the client's
 * timezone; `squire_propose_squire` turns the Lead's answer into proposal
 * items the user accepts (SquireActions runs the `squire-create` executor).
 *
 * @module squire/SquireLeadOnboarding
 */
import {
  isUnknownUnionMember,
  ProjectId,
  RunId,
  SQUIRE_ONBOARDING_MAX_PROJECTS,
  SQUIRE_ONBOARDING_MAX_THREADS,
  SquireCardId,
  SquireCardPayload,
  SquireCardTrigger,
  SquireCompanion,
  SquireCompanionChoiceStruct,
  squireDistinctChoice,
  squireDistinctCompanion,
  SquireError,
  SquireEvent,
  type SquireGrantInput,
  type SquireLeadOpenInput,
  type SquireLeadOpenResult,
  type SquireNotifyLevel,
  type SquireOnboardingContext,
  SquireNotifyLevel as SquireNotifyLevelSchema,
  type SquirePermissionLevel,
  SquirePermissionLevel as SquirePermissionLevelSchema,
  TrimmedNonEmptyString,
  type OrchestrationV2ThreadShell,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import { isSquireThread } from "./squireThread.ts";
import {
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
  SquireToolRegistry,
} from "./squireToolKit.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

export class SquireLeadOnboarding extends Context.Service<
  SquireLeadOnboarding,
  {
    /**
     * `squire.lead.open`: creates the Lead if absent, stores the
     * client's timezone when the Lead has none, and enqueues `onboarding`
     * once: on `start`, or on a plain first open before the user has chatted
     * with the Lead. A Lead without a provider keeps the row pending until it
     * has one.
     */
    readonly open: (
      input: typeof SquireLeadOpenInput.Type,
    ) => Effect.Effect<typeof SquireLeadOpenResult.Type, SquireError>;
  }
>()("lecturn/squire/SquireLeadOnboarding") {}

/** Matches the key the dev fixture's `inject` gives the event, so the two dedupe. */
const ONBOARDING_STATE_KEY = "onboarding";
const QUEUED_LOG_KIND = "onboarding.queued";
const MAX_GRANTS = 10;

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const encodeTrigger = Schema.encodeSync(Schema.fromJsonString(SquireCardTrigger));
const encodeLogData = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCompanionJson = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCompanion));
const decodePayloadJson = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardPayload));
const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ requestId: Schema.optionalKey(Schema.String) })),
);

const titleOf = (name: string) => `New Squire: ${name}`;
const cut = (text: string, max: number) =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`;
const isoOf = (at: DateTime.Utc | null | undefined) =>
  at === null || at === undefined ? null : DateTime.formatIso(at);

// ── squire_propose_squire args ──

const ScopeEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: Schema.optionalKey(TrimmedNonEmptyString),
    name: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("staveSpace"), spaceId: TrimmedNonEmptyString }),
]);

export const ProposeSquireArgs = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  brief: Schema.String.check(Schema.isMaxLength(4000)),
  scope: Schema.Array(ScopeEntry).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_GRANTS)),
  permissions: Schema.optionalKey(
    Schema.Struct({
      steer: Schema.optionalKey(SquirePermissionLevelSchema),
      createThread: Schema.optionalKey(SquirePermissionLevelSchema),
      notify: Schema.optionalKey(SquireNotifyLevelSchema),
    }),
  ),
  // Absent stays absent, so the server picks a look no other Squire has.
  companion: Schema.optionalKey(SquireCompanionChoiceStruct),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
});
export type ProposeSquireArgs = typeof ProposeSquireArgs.Type;

const str = (description: string) => ({ type: "string", description });
const level = (description: string) => ({
  type: "string",
  enum: ["off", "recommend"],
  description,
});

const proposeSquireDefinition: SquireToolHandler["definition"] = {
  name: "squire_propose_squire",
  description:
    "Propose a new Squire as an item the user accepts, edits, or skips. Scope it to whole projects, or a Stave space when the projects share one. Only the user creates the Squire.",
  inputSchema: {
    type: "object",
    properties: {
      name: str("A short name, e.g. `Release`."),
      brief: str("What the Squire watches for and how it acts; the user can edit it."),
      scope: {
        type: "array",
        description: "Whole projects (by name or id), or a Stave space.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["project", "staveSpace"] },
            projectId: str("A project id."),
            name: str("A project name, when no id is given."),
            spaceId: str("A Stave space id, for kind `staveSpace`."),
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      permissions: {
        type: "object",
        description: "Defaults to recommend-only: steer and createThread recommend, notify on.",
        properties: {
          steer: level("Steering."),
          createThread: level("Creating threads."),
          notify: { type: "string", enum: ["off", "on"], description: "Phone alerts." },
        },
        additionalProperties: false,
      },
      companion: {
        type: "object",
        description:
          "Propose a figure: appearance, hood, equipment, palette (never gold or brass, which read as the Lead's), motion. Give each proposal its own appearance and hood. Prefer presence `figure`; an emblem (frame, weight, glow) reads as a bare monogram in a row, so choose one only on purpose.",
      },
      reason: str("Why, citing the recent activity that fits the brief."),
    },
    required: ["name", "brief", "scope", "reason"],
    additionalProperties: false,
  },
};

/** Recommend-only by default; only the user raises a proposal to Auto, from Edit. */
const proposalPermissions = (asked: ProposeSquireArgs["permissions"]) => {
  const atMost = (value: SquirePermissionLevel | undefined): SquirePermissionLevel =>
    value === "off" ? "off" : "recommend";
  const notify: SquireNotifyLevel = asked?.notify ?? "on";
  return {
    steer: atMost(asked?.steer),
    createThread: atMost(asked?.createThread),
    notify,
  };
};

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const service = yield* SquireService.SquireService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* SquireToolRegistry;
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);
  const summaries = yield* Effect.serviceOption(SquireSummaries.SquireSummaries);
  const containers = yield* Effect.serviceOption(SquireContainers.SquireContainers);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const userProjects = projects
    .list()
    .pipe(
      Effect.map((rows) =>
        rows.filter((project) => project.appBinding === undefined && project.deletedAt === null),
      ),
    );

  const spaceOf = (projectId: ProjectId) =>
    Option.isNone(containers)
      ? Effect.succeed(null)
      : containers.value
          .ofProject(projectId)
          .pipe(
            Effect.map((membership) => (membership.status === "known" ? membership.spaceId : null)),
          );

  // Never a transcript: the stored summary's goal stands in for the turn.
  const headlineOf = (shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      if (Option.isNone(summaries) || shell.latestRunId === null) return undefined;
      const stored = yield* summaries.value.read({ threadId: shell.id, runId: shell.latestRunId });
      const summary = Option.isSome(stored) ? stored.value.summary : null;
      if (summary === null) return undefined;
      const text = summary.goal.trim() || summary.outcome;
      return cut(text, 280);
    });

  /** The first-run scan, bounded to the most recently active projects and threads. */
  const scan = Effect.gen(function* () {
    const rows = yield* userProjects;
    const snapshot = yield* projections.getShellSnapshot({ location: "active" });
    const byProject = new Map<ProjectId, Array<OrchestrationV2ThreadShell>>();
    for (const shell of snapshot.threads) {
      if (isSquireThread(shell) || shell.deletedAt !== null) continue;
      const list = byProject.get(shell.projectId) ?? [];
      list.push(shell);
      byProject.set(shell.projectId, list);
    }
    const newestFirst = (a: OrchestrationV2ThreadShell, b: OrchestrationV2ThreadShell) =>
      DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt);
    const ranked = rows
      .map((project) => {
        const threads = (byProject.get(project.projectId) ?? []).toSorted(newestFirst);
        return { project, threads, lastActivity: threads[0]?.updatedAt ?? null };
      })
      .toSorted(
        (a, b) =>
          (b.lastActivity === null ? 0 : DateTime.toEpochMillis(b.lastActivity)) -
          (a.lastActivity === null ? 0 : DateTime.toEpochMillis(a.lastActivity)),
      )
      .slice(0, SQUIRE_ONBOARDING_MAX_PROJECTS);

    const out: Array<SquireOnboardingContext["projects"][number]> = [];
    for (const { project, threads, lastActivity } of ranked) {
      const shown: Array<SquireOnboardingContext["projects"][number]["threads"][number]> = [];
      for (const shell of threads.slice(0, SQUIRE_ONBOARDING_MAX_THREADS)) {
        const headline = yield* headlineOf(shell);
        shown.push({
          threadId: shell.id,
          title: cut(shell.title, 200),
          status: shell.status,
          lastActivityAt: isoOf(shell.updatedAt),
          pullRequests: (shell.pullRequests ?? []).slice(0, 5).map((link) => ({
            number: link.number,
            ...(link.snapshot ? { state: link.snapshot.state } : {}),
          })),
          ...(headline === undefined ? {} : { headline }),
        });
      }
      const spaceId = yield* spaceOf(project.projectId);
      out.push({
        projectId: project.projectId,
        name: cut(project.title, 200),
        ...(spaceId === null ? {} : { staveSpaceId: spaceId }),
        lastActivityAt: isoOf(lastActivity),
        threadCount: threads.length,
        threads: shown,
      });
    }
    return { projects: out } satisfies SquireOnboardingContext;
  });

  const validZone = (zone: string | undefined) =>
    zone !== undefined && Option.isSome(DateTime.zoneMakeNamed(zone)) ? zone : null;

  const requireLead = (requestId: string) =>
    Effect.gen(function* () {
      const existing = yield* repository.getLead.pipe(orSquireError("read the Lead"));
      if (Option.isSome(existing)) return existing.value;
      const ensured = yield* service.ensureLead({ requestId });
      if (Option.isNone(ensured)) {
        return yield* new SquireError({
          code: "not_found",
          message: "No Lead yet: add a project first.",
        });
      }
      const created = yield* repository.getLead.pipe(orSquireError("read the Lead"));
      if (Option.isNone(created)) {
        return yield* new SquireError({ code: "not_found", message: "No Lead yet." });
      }
      return created.value;
    });

  /** The request that queued onboarding; a retry of it reports the same result. */
  const queuedBy = (leadId: SquireRepository.SquireRow["id"]) =>
    repository
      .listActionLog({ squireId: leadId, kinds: [QUEUED_LOG_KIND], limit: 1 })
      .pipe(
        Effect.map((rows) =>
          Option.flatMap(Option.fromUndefinedOr(rows[0]), (row) =>
            Option.flatMapNullishOr(decodeLogData(row.data_json), (data) => data.requestId),
          ),
        ),
      );

  const open: SquireLeadOnboarding["Service"]["open"] = (input) =>
    Effect.gen(function* () {
      const lead = yield* requireLead(input.requestId);
      const zone = validZone(input.timezone);
      const now = yield* nowIso;
      // `start` queues the scan unless one was queued already; a plain open
      // (older clients) only while `onboarded_at` is unset, which a deferred
      // open leaves and the user's first chat with the Lead stamps.
      const queueOnboarding =
        input.onboarding === "defer"
          ? false
          : input.onboarding === "start"
            ? Option.isNone(yield* queuedBy(lead.id).pipe(orSquireError("read the Lead's log")))
            : lead.onboarded_at === null;
      // Read before the transaction: the scan reads other stores, and the
      // event key keeps a concurrent open from queuing twice anyway.
      const context = queueOnboarding ? yield* scan.pipe(orSquireError("scan the projects")) : null;
      const queued = yield* repository
        .transaction(
          Effect.gen(function* () {
            // The first client's zone; a later client never moves it.
            if (zone !== null && (lead.timezone ?? null) === null) {
              yield* repository.updateSquire({
                id: lead.id,
                patch: { timezone: zone },
                updatedAt: now,
              });
            }
            if (context === null) return false;
            const inserted = yield* repository.insertTriggerEvent({
              squire_id: lead.id,
              thread_id: null,
              kind: "onboarding",
              state_key: ONBOARDING_STATE_KEY,
              payload_json: encodeEvent({ type: "onboarding", context }),
              status: "pending",
              defer_reason: null,
              not_before: now,
              batch_id: null,
              created_at: now,
            });
            yield* repository.updateSquire({
              id: lead.id,
              patch: { onboarded_at: now },
              updatedAt: now,
            });
            if (Option.isNone(inserted)) return false;
            yield* repository.insertActionLog({
              squire_id: lead.id,
              kind: QUEUED_LOG_KIND,
              room_id: null,
              post_id: null,
              trigger_id: null,
              task_id: null,
              thread_id: null,
              card_id: null,
              event_id: inserted.value,
              run_id: null,
              invocation_key: null,
              execution_key: null,
              data_json: encodeLogData({
                requestId: input.requestId,
                projects: context.projects.length,
              }),
              created_at: now,
            });
            return true;
          }),
        )
        .pipe(orSquireError("open the Lead"));
      if (queued && Option.isSome(delivery)) yield* delivery.value.wake(lead.id);
      yield* touchUserActivity(repository, now);
      const replayed =
        !queued &&
        Option.contains(
          yield* queuedBy(lead.id).pipe(orSquireError("read the Lead's log")),
          input.requestId,
        );
      return { squireId: lead.id, onboardingQueued: queued || replayed };
    });

  // ── squire_propose_squire ──

  const resolveScope = (args: ProposeSquireArgs) =>
    Effect.gen(function* () {
      const rows = yield* userProjects;
      const grants: Array<SquireGrantInput> = [];
      for (const entry of args.scope) {
        if (entry.kind === "staveSpace") {
          let known = false;
          for (const project of rows) {
            if ((yield* spaceOf(project.projectId)) === entry.spaceId) known = true;
          }
          if (!known)
            return { ok: false as const, text: `No project is in Stave space ${entry.spaceId}.` };
          grants.push({ kind: "staveSpace", targetId: entry.spaceId });
          continue;
        }
        const wanted = entry.projectId ?? entry.name;
        const project =
          wanted === undefined
            ? undefined
            : (rows.find((row) => row.projectId === wanted) ??
              rows.find((row) => row.title.toLowerCase() === wanted.toLowerCase()));
        if (project === undefined) {
          return { ok: false as const, text: `No project named "${wanted ?? ""}".` };
        }
        if (
          !grants.some((grant) => grant.kind === "project" && grant.targetId === project.projectId)
        ) {
          grants.push({ kind: "project", targetId: project.projectId });
        }
      }
      return { ok: true as const, grants };
    });

  /**
   * Distinct from every Squire, the Lead included, and every open proposal, so
   * an onboarding batch reads as different Squires. The Lead's own pick stands
   * while its appearance and hood are free; see `squireDistinctChoice`.
   */
  const proposalCompanion = (
    asked: SquireCompanion | undefined,
    openProposals: ReadonlyArray<SquireRepository.SquireCardRow>,
  ) =>
    Effect.gen(function* () {
      const squires = yield* repository.listSquires;
      const taken = [
        ...squires.flatMap((row) =>
          row.lifecycle === "deleting"
            ? []
            : Option.toArray(decodeCompanionJson(row.companion_json)),
        ),
        ...openProposals.flatMap((card) =>
          Option.toArray(decodePayloadJson(card.payload_json)).flatMap((payload) =>
            !isUnknownUnionMember(payload) && payload.type === "squire-proposal"
              ? [payload.companion]
              : [],
          ),
        ),
      ];
      return asked === undefined
        ? squireDistinctCompanion(taken)
        : squireDistinctChoice(taken, asked);
    });

  const proposeSquire = (ctx: SquireToolContext, kit: SquireToolKit) =>
    Effect.gen(function* () {
      const decoded = yield* kit.decodeArgs(ProposeSquireArgs, ctx.args);
      if (!decoded.ok) {
        return yield* kit.refuse(
          ctx,
          "invalid-arguments",
          `Invalid arguments for ${ctx.tool}: ${decoded.message}`,
        );
      }
      const args = decoded.value;
      const scope = yield* resolveScope(args);
      if (!scope.ok) return yield* kit.refuse(ctx, "scope", scope.text);
      const open = yield* repository.listCards({
        squireId: ctx.squire.id,
        kinds: ["proposal"],
        statuses: ["open"],
      });
      const sameName = open.find(
        (card) =>
          card.payload_json.includes('"type":"squire-proposal"') &&
          card.title === titleOf(args.name),
      );
      if (sameName !== undefined) {
        return yield* kit.refuse(
          ctx,
          "duplicate",
          `A proposal for ${args.name} is already open (${sameName.id}).`,
        );
      }
      const permissions = proposalPermissions(args.permissions);
      const companion = yield* proposalCompanion(args.companion, open);
      const payload: SquireCardPayload = {
        type: "squire-proposal",
        name: args.name,
        brief: args.brief,
        grants: scope.grants,
        permissions,
        companion,
      };
      const cardId = SquireCardId.make(`card:proposal:${ctx.squire.id}:${ctx.key.slice(0, 24)}`);
      const firstProject = scope.grants.find((grant) => grant.kind === "project");
      return yield* kit.commit(
        ctx,
        null,
        Effect.gen(function* () {
          yield* repository.insertCard({
            id: cardId,
            squire_id: ctx.squire.id,
            owner_squire_id: ctx.squire.id,
            kind: "proposal",
            status: "open",
            target_thread_id: null,
            project_id: firstProject === undefined ? null : ProjectId.make(firstProject.targetId),
            title: titleOf(args.name),
            why: args.reason?.trim() || args.brief,
            payload_json: encodePayload(payload),
            evidence_json: "{}",
            trigger_json: encodeTrigger({ runId: RunId.make(ctx.run.runId) }),
            intent_json: null,
            origin: ctx.run.origin === "unknown" ? "event" : ctx.run.origin,
            steer_kind: null,
            routed_task_id: null,
            rule_id: null,
            finding_key: null,
            escalate_at: null,
            opened_at: null,
            executes_at: null,
            attempt: 0,
            command_id: null,
            execution_key: null,
            dedupe_key: null,
            replaced_count: 0,
            ask_json: null,
            resolution: null,
            created_at: ctx.now,
            updated_at: ctx.now,
          });
          yield* kit.logRow(
            ctx,
            "card.created",
            { kind: "proposal", origin: ctx.run.origin, caption: null, proposal: "squire" },
            { cardId },
          );
          yield* kit.logRow(
            ctx,
            "decision.recorded",
            { tool: ctx.tool, outcome: "proposal", reason: args.reason ?? null },
            { cardId },
          );
          // The Lead's own proposals never wake it, so nothing to wake.
          return {
            result: kit.ok(`Proposed ${args.name} for the user to accept.`, {
              outcome: "proposal",
              cardId,
              grants: scope.grants,
              permissions,
            }),
          };
        }),
      );
    });

  yield* registry.register([
    {
      definition: proposeSquireDefinition,
      roles: ["lead"],
      call: proposeSquire,
    },
  ]);

  return SquireLeadOnboarding.of({ open });
});

export const layer = Layer.effect(SquireLeadOnboarding, make);
