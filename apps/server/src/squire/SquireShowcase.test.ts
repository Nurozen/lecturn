// @effect-diagnostics nodeBuiltinImport:off - The drift checks read the shipped asset sources.
/**
 * The showcase: a versioned template with only a data block
 * injected, built from stored state and captured as an MCP App card; its
 * buttons act as the user on items the page shows, from any copy of the
 * thread in this environment, and do nothing once an item has closed.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  SquireCardId,
  SquireCreateInput,
  SquireTurnSummary,
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type SquireId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@lecturn/shared/mcpApp";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { AppRuntimeState } from "../apps/AppRuntimeState.ts";
import { ServerConfig } from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireShowcase from "./SquireShowcase.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  SQUIRE_CARD_ACCEPT_TOOL,
  SQUIRE_CARD_DISMISS_TOOL,
  SQUIRE_SHOWCASE_RESOURCE_URI,
  SQUIRE_SHOWCASE_TOOL,
} from "./showcase/showcaseApp.ts";
import { SHOWCASE_STILLS } from "./showcase/stills/stills.generated.ts";
import {
  SHOWCASE_TEMPLATE_HTML,
  SHOWCASE_TEMPLATE_VERSION,
} from "./showcase/template.generated.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const billing = ProjectId.make("billing-service");
const invoice = ThreadId.make("thr_fix_invoice_rounding");
const currency = ThreadId.make("thr_currency_display");
const NOW = "2026-11-01T09:00:00.000Z";

const DATA_BLOCK =
  /(<script type="application\/json" id="squire-showcase-data">)([\s\S]*?)(<\/script>)/;
const dataOf = (html: string) => JSON.parse(DATA_BLOCK.exec(html)![2]!);
const withoutData = (html: string) => html.replace(DATA_BLOCK, "$1$3");

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

const summaryJson = (threadId: ThreadId, title: string, paths: ReadonlyArray<string>) =>
  encodeSummary({
    threadId,
    threadTitle: title,
    project: "billing-service",
    provider: ProviderDriverKind.make("codex"),
    turnId: RunId.make(`run-${threadId}`),
    outcome: "finished",
    summaryStatus: "complete",
    goal: title,
    completed: [],
    remaining: [],
    blocked: [],
    pendingQuestion: null,
    suggestedNextStep: null,
    files: {
      entries: paths.map((path) => ({ path, change: "modified" as const })),
      counts: { added: 0, modified: paths.length, deleted: 0 },
    },
    commands: [],
    pullRequest: null,
  });

const cardRow = (
  id: string,
  squireId: SquireId,
  overrides: Partial<SquireRepository.SquireCardRow> = {},
): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: squireId,
  owner_squire_id: squireId,
  kind: "steer",
  status: "open",
  target_thread_id: invoice,
  project_id: billing,
  title: "Rerun api-e2e",
  why: "api-e2e failed on #318",
  payload_json: "{}",
  evidence_json: "{}",
  trigger_json: "{}",
  intent_json: null,
  origin: "event",
  steer_kind: null,
  routed_task_id: null,
  rule_id: null,
  finding_key: null,
  escalate_at: null,
  opened_at: null,
  executes_at: null,
  expires_at: null,
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const pr = (
  number: number,
  headBranch: string,
  baseBranch: string,
  state: "open" | "merged" = "open",
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/billing",
  number,
  url: `https://github.com/acme/billing/pull/${number}`,
  source: "created",
  linkedAt: NOW,
  snapshot: {
    state,
    title: `PR ${number}`,
    headBranch,
    baseBranch,
    isDraft: false,
    updatedAt: null,
    syncedAt: NOW,
    checksState: "passing",
  },
  stack: null,
});

const baseInput = (
  overrides: Partial<SquireShowcase.ShowcaseInput> = {},
): SquireShowcase.ShowcaseInput => ({
  generatedAt: NOW,
  lead: { id: "lead", name: "Lead", still: null },
  threads: [],
  cards: [],
  squireNames: new Map(),
  environmentId: null,
  ...overrides,
});

describe("showcase page", () => {
  it("is the template with only its data block filled", () => {
    const one = SquireShowcase.renderShowcase(SquireShowcase.buildShowcaseData(baseInput()));
    const two = SquireShowcase.renderShowcase(
      SquireShowcase.buildShowcaseData(
        baseInput({
          generatedAt: "2026-11-02T10:00:00.000Z",
          lead: { id: "lead", name: "Lead </script><b>", still: null },
          cards: [cardRow("card:a", "squire-a" as SquireId)],
        }),
      ),
    );
    assert.notStrictEqual(one, two);
    assert.strictEqual(withoutData(one), withoutData(two));
    assert.strictEqual(withoutData(one), withoutData(SHOWCASE_TEMPLATE_HTML));
    // Data cannot close its script: the name round-trips as text.
    assert.strictEqual(dataOf(two).lead.name, "Lead </script><b>");
    assert.strictEqual(dataOf(two).generatedAt, "2026-11-02T10:00:00.000Z");
    assert.strictEqual(dataOf(two).templateVersion, SHOWCASE_TEMPLATE_VERSION);
  });

  it("maps shared files and PR-blocks-PR edges from stored state", () => {
    const data = SquireShowcase.buildShowcaseData(
      baseInput({
        threads: [
          {
            id: invoice,
            title: "Fix invoice rounding",
            project: "billing-service",
            projectId: billing,
            pullRequests: [pr(12, "feat/rounding", "feat/currency")],
            files: ["src/money.ts", "src/invoice.ts"],
            watchers: 2,
          },
          {
            id: currency,
            title: "Currency display",
            project: "billing-service",
            projectId: billing,
            pullRequests: [pr(10, "feat/currency", "main")],
            files: ["src/money.ts"],
            watchers: 1,
          },
          {
            id: ThreadId.make("thr_other_repo"),
            title: "Other repo",
            project: "observatory",
            projectId: ProjectId.make("observatory"),
            pullRequests: [pr(3, "feat/x", "feat/currency", "merged")],
            files: ["src/money.ts"],
            watchers: 1,
          },
        ],
        cards: [
          cardRow("card:q", "squire-a" as SquireId, { kind: "question" }),
          cardRow("card:s", "squire-a" as SquireId, {
            payload_json: JSON.stringify({ type: "steer" }),
          }),
          cardRow("card:t", "squire-a" as SquireId, {
            kind: "proposal",
            payload_json: JSON.stringify({ type: "thread-proposal" }),
          }),
          cardRow("card:p", "lead" as SquireId, {
            kind: "proposal",
            payload_json: JSON.stringify({ type: "squire-proposal" }),
          }),
          // Raised by the Lead for Release's threads.
          cardRow("card:o", "lead" as SquireId, {
            kind: "overlap",
            owner_squire_id: "squire-a" as SquireId,
            target_thread_id: null,
            payload_json: JSON.stringify({ type: "overlap" }),
          }),
          cardRow("card:f", "squire-a" as SquireId, {
            kind: "fyi",
            payload_json: JSON.stringify({ type: "fyi", source: "inactivity" }),
          }),
          cardRow("card:done", "squire-a" as SquireId, { status: "resolved" }),
        ],
        squireNames: new Map([
          ["squire-a", "Release"],
          ["lead", "Marshal"],
        ]),
        environmentId: EnvironmentId.make("env-1"),
      }),
    );
    const money = data.files.find((file) => file.key === `${billing}:src/money.ts`);
    assert.deepStrictEqual(money?.threads, [invoice, currency]);
    assert.isTrue(money?.shared);
    // The same path in another repository is another file.
    assert.isFalse(data.files.find((file) => file.key === "observatory:src/money.ts")?.shared);
    assert.isFalse(data.files.find((file) => file.path === "src/invoice.ts")?.shared);
    // #12's base is #10's head; the merged #3 blocks nothing and waits on nothing.
    assert.deepStrictEqual(data.edges, [{ from: invoice, to: currency, label: "#10" }]);
    assert.deepStrictEqual(data.threads[0]?.pr, {
      number: 12,
      state: "open",
      isDraft: false,
      checks: "passing",
    });
    // The Lead view's sum of per-Squire tracked counts, not the thread count.
    assert.deepStrictEqual(data.counts, {
      // Every open item but the FYI, as the Lead header counts them, broken down by every kind.
      needsDecision: 5,
      steers: 1,
      openQuestions: 1,
      overlaps: 1,
      proposals: 2,
      threadsWatched: 4,
    });
    // The queue's verbs; a question and an inactivity check open in Lecturn.
    assert.deepStrictEqual(
      data.items.map((item) => [
        item.id,
        item.squire,
        item.actions.map((action) => `${action.type}:${action.label}`),
      ]),
      [
        ["card:s", "Release", ["accept:Send steer", "dismiss:Dismiss"]],
        ["card:t", "Release", ["accept:Create thread", "dismiss:Dismiss"]],
        ["card:p", "Lead", ["accept:Accept", "dismiss:Dismiss"]],
        ["card:q", "Release", ["open:Open", "dismiss:Dismiss"]],
        ["card:o", "Lead", ["accept:Review", "dismiss:Dismiss"]],
        ["card:f", "Release", ["open:Open"]],
      ],
    );
    const overlap = data.items.find((item) => item.id === "card:o");
    assert.strictEqual(overlap?.owner, "Release");
    assert.strictEqual(overlap?.link, "lecturn://squires/env-1/squire-a?item=card%3Ao");
    assert.isNull(
      SquireShowcase.buildShowcaseData(
        baseInput({ cards: [cardRow("card:q", "squire-a" as SquireId, { kind: "question" })] }),
      ).items[0]?.link,
    );
  });

  it("gives a turn summary FYI the queue's outcome text, and other items none", () => {
    const data = SquireShowcase.buildShowcaseData(
      baseInput({
        cards: [
          cardRow("card:summary", "squire-a" as SquireId, {
            kind: "fyi",
            title: "Fix invoice rounding",
            payload_json: JSON.stringify({
              type: "fyi",
              source: "summary",
              text: "Fix invoice rounding: checks passed\nTwo files changed.",
            }),
          }),
          cardRow("card:notify", "squire-a" as SquireId, {
            kind: "fyi",
            title: "Staging",
            payload_json: JSON.stringify({
              type: "fyi",
              source: "notify",
              text: "Staging is frozen",
            }),
          }),
          cardRow("card:steer", "squire-a" as SquireId, {
            payload_json: JSON.stringify({ type: "steer" }),
          }),
        ],
      }),
    );
    assert.deepStrictEqual(
      data.items.map((item) => [item.id, item.outcome]),
      [
        ["card:steer", null],
        ["card:summary", "checks passed"],
        ["card:notify", null],
      ],
    );
  });

  it("orders the file column so no two thread-to-file edges cross", () => {
    // The overlap stills' shape: two threads, five files, one shared.
    const data = SquireShowcase.buildShowcaseData(
      baseInput({
        threads: [
          {
            id: invoice,
            title: "Fix invoice rounding",
            project: "billing-service",
            projectId: billing,
            pullRequests: [],
            files: ["src/zeta.ts", "src/money.ts", "src/invoice.ts"],
            watchers: 1,
          },
          {
            id: currency,
            title: "Currency display",
            project: "billing-service",
            projectId: billing,
            pullRequests: [],
            files: ["src/alpha.ts", "src/money.ts", "src/format.ts"],
            watchers: 1,
          },
        ],
      }),
    );
    assert.deepStrictEqual(
      data.files.map((file) => file.path),
      ["src/invoice.ts", "src/zeta.ts", "src/money.ts", "src/alpha.ts", "src/format.ts"],
    );
    const row = new Map(data.threads.map((thread, index) => [thread.id, index]));
    const edges = data.files.flatMap((file, fileIndex) =>
      file.threads.map((threadId) => [row.get(threadId)!, fileIndex] as const),
    );
    const inversions = edges.filter(([threadA, fileA]) =>
      edges.some(([threadB, fileB]) => threadA < threadB && fileA > fileB),
    );
    assert.deepStrictEqual(inversions, []);
  });

  it.effect("ships the template and the still set as their sources say", () =>
    Effect.gen(function* () {
      const dir = NodePath.join(import.meta.dirname, "showcase");
      assert.strictEqual(
        SHOWCASE_TEMPLATE_HTML,
        NodeFS.readFileSync(NodePath.join(dir, "template.html"), "utf8"),
      );
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "stills/manifest.json"), "utf8"),
      );
      assert.lengthOf(manifest.stills, 24);
      assert.sameMembers(
        Object.keys(SHOWCASE_STILLS),
        manifest.stills.map((still: { readonly key: string }) => still.key),
      );
      for (const still of manifest.stills) {
        const bytes = Buffer.from(SHOWCASE_STILLS[still.key]?.base64 ?? "", "base64");
        assert.strictEqual(bytes.byteLength, still.bytes, still.key);
        const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        assert.strictEqual(sha, still.sha256, still.key);
        assert.strictEqual(SHOWCASE_STILLS[still.key]?.sha256, still.sha256, still.key);
        // Recorded by decoding each still (squire-showcase-assets.ts).
        assert.strictEqual(still.colouredUnderAlpha0, 0, still.key);
      }
      assert.match(
        (yield* SquireShowcase.leadStill(
          JSON.stringify({ appearance: "male", hood: "up", equipment: "lance" }),
        ))!,
        /^data:image\/webp;base64,/,
      );
    }),
  );
});

type Services = Phase4Services | Scope.Scope;

interface Env {
  readonly leadId: SquireId;
  readonly leadThreadId: ThreadId;
  readonly releaseId: SquireId;
}

// layerSquire builds the showcase, its route, and the tool registry (switch on).
const showcaseLayer = phase4Layer;

/** Release tracks billing-service's two threads; the Lead publishes over them. */
const withShowcase = <A, E>(body: (env: Env) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(billing, initRepo(`${root}/billing-service`));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const [threadId, title] of [
        [invoice, "Fix invoice rounding"],
        [currency, "Currency display"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: billing,
          title,
          modelSelection: scriptedModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const service = yield* need(SquireService.SquireService);
      const release = yield* service.create(
        decodeCreateInput({
          requestId: "release",
          homeProjectId: billing,
          providerInstanceId: scripted,
          modelSelection: scriptedModel,
          name: "Release",
          brief: "",
          grants: [{ kind: "project", targetId: billing }],
          events: {},
          permissions: {},
          budgets: {},
        }),
      );
      const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
      return yield* body({
        leadId: lead.id,
        leadThreadId: lead.homeThreadId!,
        releaseId: release.id,
      });
    }).pipe(Effect.scoped, Effect.provide(showcaseLayer(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

const publish = (env: Env) =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call(
      { squireId: env.leadId, role: "lead", threadId: env.leadThreadId },
      SQUIRE_SHOWCASE_TOOL,
      {},
    ),
  );

const route = Effect.gen(function* () {
  const { squireMcpAppRoute } = yield* AppRuntimeState;
  return Option.getOrThrow(yield* Ref.get(squireMcpAppRoute));
});

describe("SquireShowcase", () => {
  it.effect("publishes stored state as a captured card, recording time and version", () =>
    withShowcase((env) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        for (const [threadId, title, paths] of [
          [invoice, "Fix invoice rounding", ["src/money.ts", "src/invoice.ts"]],
          [currency, "Currency display", ["src/money.ts"]],
        ] as const) {
          yield* repository.insertSummary({
            thread_id: threadId,
            run_id: RunId.make(`run-${threadId}`),
            stage: "terminal",
            status: "complete",
            summary_json: summaryJson(threadId, title, paths),
            payer_squire_id: env.releaseId,
            created_at: NOW,
            updated_at: NOW,
          });
        }
        yield* repository.insertCard(cardRow("card:steer:release:1", env.releaseId));

        const tools = yield* need(SquireTools.SquireTools);
        const listed = tools.definitions("lead").find((tool) => tool.name === SQUIRE_SHOWCASE_TOOL);
        // No declared resource for Codex to try to read.
        assert.isDefined(listed);
        assert.notProperty(listed, "_meta");

        const result = yield* publish(env);
        assert.isFalse(result.isError, result.text);
        assert.strictEqual(
          result.text,
          "Published the showcase: 1 needs a decision (1 steer), 2 threads watched.",
        );
        const structured = result.structuredContent as Record<string, unknown>;
        const reference = readMcpAppReference(structured[MCP_APP_OUTPUT_KEY])!;
        assert.include(reference, {
          server: "lecturn",
          tool: SQUIRE_SHOWCASE_TOOL,
          resourceUri: SQUIRE_SHOWCASE_RESOURCE_URI,
        });

        const { attachmentsDir } = yield* ServerConfig;
        const html = NodeFS.readFileSync(
          NodePath.join(attachmentsDir, `${reference.attachmentId}.html`),
          "utf8",
        );
        const data = dataOf(html);
        assert.strictEqual(data.templateVersion, SHOWCASE_TEMPLATE_VERSION);
        assert.strictEqual(data.counts.threadsWatched, 2);
        assert.strictEqual(data.counts.needsDecision, 1);
        assert.isTrue(
          data.files.find((file: { path: string }) => file.path === "src/money.ts").shared,
        );
        assert.match(data.lead.still, /^data:image\/webp;base64,/);

        const log = yield* repository.listActionLog({
          squireId: env.leadId,
          kinds: ["showcase.published"],
          limit: 10,
        });
        assert.lengthOf(log, 1);
        const recorded = JSON.parse(log[0]!.data_json);
        assert.strictEqual(recorded.templateVersion, SHOWCASE_TEMPLATE_VERSION);
        assert.strictEqual(recorded.generatedAt, data.generatedAt);
        assert.strictEqual(recorded.attachmentId, reference.attachmentId);
        assert.deepStrictEqual(recorded.itemIds, ["card:steer:release:1"]);

        // A retried call is the same page, not a second one.
        const again = yield* publish(env);
        assert.deepStrictEqual(again.structuredContent, result.structuredContent);
      }),
    ),
  );

  it.effect("buttons act from a copy, and do nothing on an item that has closed", () =>
    withShowcase((env) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.insertCard(cardRow("card:steer:release:1", env.releaseId));
        yield* repository.insertCard(
          cardRow("card:fyi:release:2", env.releaseId, { kind: "fyi", target_thread_id: currency }),
        );
        const result = yield* publish(env);
        const structured = result.structuredContent as Record<string, unknown>;
        // As an adapter records the call: the MCP result around the envelope.
        const output = {
          content: [{ type: "text", text: result.text }],
          structuredContent: structured,
        };
        const card = {
          // A copy of the Lead's thread: the card is authorized by its items, not its thread.
          threadId: ThreadId.make("thr_copy_of_lead"),
          itemId: TurnItemId.make("item-copied"),
          app: readMcpAppReference(structured[MCP_APP_OUTPUT_KEY])!,
          output,
        };
        const squireRoute = yield* route;

        const info = yield* squireRoute.toolInfo({ ...card, name: SQUIRE_CARD_DISMISS_TOOL });
        assert.include(info, { callable: true, readOnly: false });

        const dismissed = yield* squireRoute.callTool({
          ...card,
          name: SQUIRE_CARD_DISMISS_TOOL,
          arguments: { cardId: "card:fyi:release:2" },
        });
        assert.notStrictEqual(dismissed.isError, true);
        const after = Option.getOrThrow(
          yield* repository.getCard(SquireCardId.make("card:fyi:release:2")),
        );
        assert.strictEqual(after.status, "dismissed");

        // Closed elsewhere since the page was published.
        yield* repository.updateCard({
          id: SquireCardId.make("card:steer:release:1"),
          fromStatuses: ["open"],
          patch: { status: "resolved", resolution: "accepted" },
          updatedAt: NOW,
        });
        for (const [name, cardId] of [
          [SQUIRE_CARD_ACCEPT_TOOL, "card:steer:release:1"],
          [SQUIRE_CARD_ACCEPT_TOOL, "card:fyi:release:2"],
        ] as const) {
          const outcome = yield* squireRoute.callTool({ ...card, name, arguments: { cardId } });
          assert.include(outcome.structuredContent as object, { outdated: true });
        }
        const resolved = Option.getOrThrow(
          yield* repository.getCard(SquireCardId.make("card:steer:release:1")),
        );
        assert.include(resolved, { status: "resolved", resolution: "accepted", command_id: null });

        // An item the page never showed is out of its reach.
        yield* repository.insertCard(cardRow("card:steer:release:3", env.releaseId));
        const unshown = yield* squireRoute.callTool({
          ...card,
          name: SQUIRE_CARD_DISMISS_TOOL,
          arguments: { cardId: "card:steer:release:3" },
        });
        assert.isTrue(unshown.isError);
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getCard(SquireCardId.make("card:steer:release:3")))
            .status,
          "open",
        );
      }),
    ),
  );
});

describe("showcaseDecisionBreakdown", () => {
  it("lists every decision kind present, and nothing when none is", () => {
    assert.strictEqual(
      SquireShowcase.showcaseDecisionBreakdown({
        steers: 1,
        openQuestions: 1,
        overlaps: 1,
        proposals: 2,
      }),
      "1 steer, 1 open question, 1 overlap, 2 proposals",
    );
    assert.strictEqual(
      SquireShowcase.showcaseDecisionBreakdown({
        steers: 0,
        openQuestions: 0,
        overlaps: 0,
        proposals: 0,
      }),
      "",
    );
  });
});
