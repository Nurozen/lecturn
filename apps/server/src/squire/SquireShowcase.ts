/**
 * `squire_publish_showcase` (P18, D32): the Lead's snapshot page. Data comes
 * from stored items, summaries, and PR snapshots at publish time and is
 * injected as one JSON block into the versioned template; the Lead never
 * writes markup and the page reads nothing afterwards. The result carries the
 * same `lecturnMcpApp` envelope connected-app cards do, with the document
 * captured as an attachment, so the card survives restarts and copies.
 *
 * The tool declares no `_meta.ui.resourceUri` and /mcp never serves the
 * template: a declared resource makes Codex try to read it (R54).
 */
import {
  SQUIRE_LEAD_COMPANION,
  SquireCompanion,
  SquireTurnSummary,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import { MCP_APP_MIME_TYPE, MCP_APP_OUTPUT_KEY } from "@lecturn/shared/mcpApp";
import { LECTURN_MCP_APP_SERVER } from "@lecturn/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { snapshotMcpApp } from "../mcpApps/McpAppSnapshot.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { squireFyiOutcome } from "./SquireItems.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import { SQUIRE_SHOWCASE_RESOURCE_URI, SQUIRE_SHOWCASE_TOOL } from "./showcase/showcaseApp.ts";
import { SHOWCASE_STILL_SET, SHOWCASE_STILLS } from "./showcase/stills/stills.generated.ts";
import {
  SHOWCASE_TEMPLATE_HTML,
  SHOWCASE_TEMPLATE_VERSION,
} from "./showcase/template.generated.ts";
import {
  SquireToolRegistry,
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
} from "./squireToolKit.ts";

// Bounds keep the page readable and its document far under the 5 MB limit.
const MAX_THREADS = 24;
const MAX_FILES = 40;
const MAX_FILES_PER_THREAD = 12;
const MAX_ITEMS = 30;
const SUMMARIES_PER_THREAD = 20;

const DATA_PLACEHOLDER = "{{SQUIRE_SHOWCASE_DATA}}";

export interface ShowcaseThreadInput {
  readonly id: ThreadId;
  readonly title: string;
  readonly project: string;
  readonly projectId: ProjectId;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  /** Repo-relative paths from the thread's stored summaries, newest first. */
  readonly files: ReadonlyArray<string>;
  /** Team Squires tracking the thread: the Lead view's "threads watched" sums these. */
  readonly watchers: number;
}

export interface ShowcaseInput {
  readonly generatedAt: string;
  readonly lead: { readonly id: string; readonly name: string; readonly still: string | null };
  /** Every tracked thread, most recently updated first. */
  readonly threads: ReadonlyArray<ShowcaseThreadInput>;
  /** Open cards, oldest first. */
  readonly cards: ReadonlyArray<SquireRepository.SquireCardRow>;
  readonly squireNames: ReadonlyMap<string, string>;
  /** Null when the server cannot name its environment; items then have no link. */
  readonly environmentId: EnvironmentId | null;
}

const livePullRequests = (thread: ShowcaseThreadInput) =>
  thread.pullRequests.flatMap((link) =>
    link.snapshot === null || link.source === "stack-dismissed"
      ? []
      : [{ link, snapshot: link.snapshot }],
  );

const DECISION_ORDER = ["steer", "proposal", "question", "overlap", "fyi"] as const;

const decodePayloadType = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.String, source: Schema.optionalKey(Schema.String) }),
  ),
);

type ShowcaseAction = { readonly type: "accept" | "dismiss" | "open"; readonly label: string };
const DISMISS: ShowcaseAction = { type: "dismiss", label: "Dismiss" };
const OPEN: ShowcaseAction = { type: "open", label: "Open" };

/** The queue's primary verbs (`squireCardPrimaryLabel`), so one kind reads the same on both. */
const PRIMARY_LABELS: Record<string, string> = {
  steer: "Send steer",
  "thread-proposal": "Create thread",
  "squire-proposal": "Accept",
  "room-proposal": "Open room",
  control: "Accept",
  overlap: "Review",
};

const itemActions = (card: SquireRepository.SquireCardRow): ReadonlyArray<ShowcaseAction> => {
  const payload = Option.getOrUndefined(decodePayloadType(card.payload_json));
  switch (card.kind) {
    // Answering needs the request's options, which only Lecturn shows.
    case "question":
      return [OPEN, DISMISS];
    // P3.6: an inactivity check's dismiss pauses triggers, so it never gets a plain Dismiss.
    case "fyi":
      return payload?.source === "inactivity" ? [OPEN] : [DISMISS];
    default: {
      const label =
        (payload === undefined ? undefined : PRIMARY_LABELS[payload.type]) ??
        PRIMARY_LABELS[card.kind] ??
        "Accept";
      return [{ type: "accept", label }, DISMISS];
    }
  }
};

/** The app's deep link to the item in its owner's queue (`promptLinkAppPath`). */
const itemLink = (environmentId: EnvironmentId | null, card: SquireRepository.SquireCardRow) =>
  environmentId === null
    ? null
    : `lecturn://squires/${encodeURIComponent(environmentId)}/${encodeURIComponent(
        card.owner_squire_id,
      )}?item=${encodeURIComponent(card.id)}`;

/**
 * The map's file column, ordered by the mean position of the threads that touch each file
 * (a barycentric sort): a thread's own files sit beside it and a file two threads share sits
 * between them, so edges from an earlier thread never cross below a later thread's edges.
 */
export const orderFilesByThreads = <
  File extends { readonly path: string; readonly threads: ReadonlyArray<ThreadId> },
>(
  threadOrder: ReadonlyArray<ThreadId>,
  files: ReadonlyArray<File>,
): Array<File> => {
  const position = new Map(threadOrder.map((id, index) => [id, index]));
  const rank = (file: File) => {
    const indexes = file.threads.map((id) => position.get(id) ?? threadOrder.length);
    return {
      mean: indexes.reduce((sum, index) => sum + index, 0) / Math.max(indexes.length, 1),
      first: Math.min(...indexes),
    };
  };
  const ranks = new Map(files.map((file) => [file, rank(file)]));
  return files.toSorted((a, b) => {
    const ra = ranks.get(a)!;
    const rb = ranks.get(b)!;
    return ra.mean - rb.mean || ra.first - rb.first || a.path.localeCompare(b.path);
  });
};

/** Pure, so the page's content is testable without a template. */
export const buildShowcaseData = (input: ShowcaseInput) => {
  const threads = input.threads.slice(0, MAX_THREADS);
  const shown = new Set(threads.map((thread) => thread.id));

  const fileMap = new Map<
    string,
    { key: string; path: string; project: string; threads: Array<ThreadId> }
  >();
  for (const thread of threads) {
    for (const path of [...new Set(thread.files)].slice(0, MAX_FILES_PER_THREAD)) {
      // Path alone collides across repositories (D30).
      const key = `${thread.projectId}:${path}`;
      const entry = fileMap.get(key) ?? { key, path, project: thread.project, threads: [] };
      entry.threads.push(thread.id);
      fileMap.set(key, entry);
    }
  }
  // Shared files win the cut; the column is then ordered so thread-to-file edges do not cross.
  const files = orderFilesByThreads(
    threads.map((thread) => thread.id),
    [...fileMap.values()]
      .toSorted((a, b) => b.threads.length - a.threads.length || a.path.localeCompare(b.path))
      .slice(0, MAX_FILES),
  ).map((file) => ({ ...file, shared: file.threads.length >= 2 }));

  // A PR whose base branch is another tracked PR's head waits on that PR.
  const edges: Array<{ from: ThreadId; to: ThreadId; label: string }> = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    for (const { link, snapshot } of livePullRequests(thread)) {
      if (snapshot.state !== "open") continue;
      for (const other of threads) {
        if (other.id === thread.id) continue;
        for (const base of livePullRequests(other)) {
          const key = `${thread.id}>${other.id}`;
          if (
            seen.has(key) ||
            base.snapshot.state !== "open" ||
            base.link.host !== link.host ||
            base.link.repository !== link.repository ||
            base.snapshot.headBranch !== snapshot.baseBranch
          ) {
            continue;
          }
          seen.add(key);
          edges.push({ from: thread.id, to: other.id, label: `#${base.link.number}` });
        }
      }
    }
  }

  const open = input.cards.filter((card) => card.status === "open");
  const nameOf = (squireId: string) =>
    squireId === input.lead.id ? "Lead" : (input.squireNames.get(squireId) ?? "Squire");
  const items = open
    .toSorted((a, b) => DECISION_ORDER.indexOf(a.kind) - DECISION_ORDER.indexOf(b.kind))
    .slice(0, MAX_ITEMS)
    .map((card) => ({
      id: card.id,
      kind: card.kind,
      title: card.title,
      // A turn summary reads "<thread> · <outcome>", as the queue's row does.
      outcome:
        card.kind === "fyi" ? (squireFyiOutcome(card.title, card.payload_json) ?? null) : null,
      why: card.why,
      thread:
        card.target_thread_id !== null && shown.has(card.target_thread_id)
          ? card.target_thread_id
          : null,
      // The raiser, not the owner: the Lead raises overlaps for other Squires' threads (P17.3).
      squire: nameOf(card.squire_id),
      owner: nameOf(card.owner_squire_id),
      link: itemLink(input.environmentId, card),
      actions: itemActions(card),
    }));

  return {
    templateVersion: SHOWCASE_TEMPLATE_VERSION,
    generatedAt: input.generatedAt,
    lead: { name: input.lead.name, still: input.lead.still },
    counts: {
      // The Lead header's "need a decision": every open item but an FYI, broken down by kind.
      needsDecision: open.filter((card) => card.kind !== "fyi").length,
      steers: open.filter((card) => card.kind === "steer").length,
      openQuestions: open.filter((card) => card.kind === "question").length,
      overlaps: open.filter((card) => card.kind === "overlap").length,
      proposals: open.filter((card) => card.kind === "proposal").length,
      threadsWatched: input.threads.reduce((sum, thread) => sum + thread.watchers, 0),
    },
    threads: threads.map((thread) => {
      const live = livePullRequests(thread);
      const primary = live.findLast(({ snapshot }) => snapshot.state === "open") ?? live.at(-1);
      return {
        id: thread.id,
        title: thread.title,
        project: thread.project,
        pr:
          primary === undefined
            ? null
            : {
                number: primary.link.number,
                state: primary.snapshot.state,
                isDraft: primary.snapshot.isDraft,
                checks: primary.snapshot.checksState ?? null,
              },
      };
    }),
    files,
    edges,
    items,
  };
};
export type ShowcaseData = ReturnType<typeof buildShowcaseData>;

const [TEMPLATE_HEAD, TEMPLATE_TAIL, ...extra] = SHOWCASE_TEMPLATE_HTML.split(DATA_PLACEHOLDER);
if (TEMPLATE_TAIL === undefined || extra.length > 0) {
  throw new Error("The showcase template must hold exactly one data placeholder.");
}

/** Only the data block varies between publishes. `<` is escaped so data cannot close the script. */
export const renderShowcase = (data: ShowcaseData) =>
  `${TEMPLATE_HEAD}${JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029")}${TEMPLATE_TAIL}`;

const decodeCompanion = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCompanion));
const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(SquireTurnSummary));

/** The Lead's figure from the still set; the set, not code, decides tint and crest. */
export const leadStill = (companionJson: string) => {
  const companion = Option.getOrElse(decodeCompanion(companionJson), () => SQUIRE_LEAD_COMPANION);
  const still = SHOWCASE_STILLS[`${companion.appearance}-${companion.hood}-${companion.equipment}`];
  return still === undefined ? null : `data:${SHOWCASE_STILL_SET.mimeType};base64,${still.base64}`;
};

const definition = {
  name: SQUIRE_SHOWCASE_TOOL,
  description:
    "Publish the showcase: a snapshot page of your Squires' open items, tracked threads, and the files they touch, shown as a card in your thread. Lecturn builds the page; you never write its markup.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const NoArgs = Schema.Struct({});

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Every decision kind present, in queue order; empty when there are none. */
export const showcaseDecisionBreakdown = (counts: {
  readonly steers: number;
  readonly openQuestions: number;
  readonly overlaps: number;
  readonly proposals: number;
}) =>
  [
    plural(counts.steers, "steer"),
    plural(counts.openQuestions, "open question"),
    plural(counts.overlaps, "overlap"),
    plural(counts.proposals, "proposal"),
  ]
    .filter(
      (_, index) =>
        [counts.steers, counts.openQuestions, counts.overlaps, counts.proposals][index]! > 0,
    )
    .join(", ");

export const make = Effect.gen(function* () {
  const registry = yield* SquireToolRegistry;
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { attachmentsDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  // Optional, so a harness without an environment still publishes, without item links.
  const environment = Option.getOrUndefined(yield* Effect.serviceOption(ServerEnvironment));

  const projectTitle = (projectId: ProjectId) =>
    projects
      .get(projectId, { includeDeleted: true })
      .pipe(Effect.map(Option.match({ onNone: () => "", onSome: (row) => row.title })));

  const threadInput = ({
    shell,
    watchers,
  }: {
    readonly shell: OrchestrationV2ThreadShell;
    readonly watchers: number;
  }) =>
    Effect.gen(function* () {
      const summaries = yield* repository.listThreadSummaries({
        threadId: shell.id,
        limit: SUMMARIES_PER_THREAD,
      });
      const files = summaries.flatMap((row) =>
        Option.match(decodeSummary(row.summary_json), {
          onNone: () => [],
          onSome: (summary) => summary.files.entries.map((entry) => entry.path),
        }),
      );
      return {
        id: shell.id,
        title: shell.title,
        project: yield* projectTitle(shell.projectId),
        projectId: shell.projectId,
        pullRequests: shell.pullRequests ?? [],
        files,
        watchers,
      } satisfies ShowcaseThreadInput;
    });

  const collect = (ctx: SquireToolContext) =>
    Effect.gen(function* () {
      const squires = yield* repository.listSquires;
      // The Lead view's team (`SquireReadModel` drops deleting rows), so the counts agree.
      const team = new Set(
        squires
          .filter((row) => row.role !== "lead" && row.lifecycle !== "deleting")
          .map((row) => row.id),
      );
      const snapshot = yield* projections.getShellSnapshot({ location: "active" });
      const tracked: Array<{ shell: OrchestrationV2ThreadShell; watchers: number }> = [];
      for (const shell of snapshot.threads) {
        const trackers = yield* scope.trackersOf(shell.id);
        if (trackers.length === 0) continue;
        tracked.push({ shell, watchers: trackers.filter((id) => team.has(id)).length });
      }
      const threads = yield* Effect.forEach(
        tracked.toSorted(
          (a, b) =>
            DateTime.toEpochMillis(b.shell.updatedAt) - DateTime.toEpochMillis(a.shell.updatedAt),
        ),
        threadInput,
      );
      return buildShowcaseData({
        generatedAt: ctx.now,
        lead: {
          id: ctx.squire.id,
          name: ctx.squire.name,
          still: leadStill(ctx.squire.companion_json),
        },
        threads,
        cards: yield* repository.listCards({ statuses: ["open"] }),
        squireNames: new Map(squires.map((row) => [row.id, row.name])),
        environmentId: environment === undefined ? null : yield* environment.getEnvironmentId,
      });
    });

  const publish = (ctx: SquireToolContext, kit: SquireToolKit) =>
    Effect.gen(function* () {
      const decoded = yield* kit.decodeArgs(NoArgs, ctx.args);
      if (!decoded.ok) {
        return yield* kit.refuse(ctx, "invalid-arguments", `Invalid arguments: ${decoded.message}`);
      }
      const data = yield* collect(ctx);
      const reference = yield* snapshotMcpApp({
        attachmentsDir,
        threadId: ctx.caller.threadId,
        server: LECTURN_MCP_APP_SERVER,
        tool: SQUIRE_SHOWCASE_TOOL,
        resourceUri: SQUIRE_SHOWCASE_RESOURCE_URI,
        contents: [
          {
            uri: SQUIRE_SHOWCASE_RESOURCE_URI,
            mimeType: MCP_APP_MIME_TYPE,
            text: renderShowcase(data),
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      if (reference === undefined) {
        return yield* kit.refuse(
          ctx,
          "capture",
          "The showcase page could not be saved. Try again.",
        );
      }
      const itemIds = data.items.map((item) => item.id);
      const { counts } = data;
      const breakdown = showcaseDecisionBreakdown(counts);
      const text = `Published the showcase: ${counts.needsDecision} ${counts.needsDecision === 1 ? "needs" : "need"} a decision${breakdown === "" ? "" : ` (${breakdown})`}, ${plural(counts.threadsWatched, "thread")} watched.`;
      const record = {
        leadId: ctx.squire.id,
        templateVersion: data.templateVersion,
        generatedAt: data.generatedAt,
        itemIds,
      };
      const filePath = resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: `${reference.attachmentId}.html`,
      });
      return yield* kit
        .commit(
          ctx,
          null,
          Effect.gen(function* () {
            yield* kit.logRow(ctx, "showcase.published", {
              ...record,
              attachmentId: reference.attachmentId,
              counts,
            });
            return {
              result: {
                isError: false,
                text,
                structuredContent: {
                  [MCP_APP_OUTPUT_KEY]: reference,
                  result: {
                    content: [{ type: "text", text }],
                    structuredContent: { showcase: record },
                  },
                },
              },
            };
          }),
        )
        .pipe(
          // Only the committed result names the document, so an unrecorded one is removed.
          Effect.onError(() =>
            filePath === null
              ? Effect.void
              : fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore),
          ),
        );
    });

  const handler: SquireToolHandler = { definition, roles: ["lead"], call: publish };
  yield* registry.register([handler]);
});

export const layer = Layer.effectDiscard(make);
