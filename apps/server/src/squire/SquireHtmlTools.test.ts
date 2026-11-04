// @effect-diagnostics nodeBuiltinImport:off - The test reads the stored page directly.
/**
 * `html_render` and `html_preview` as Squire role tools, through the real
 * `SquireTools` on `layerSquire`: always locked, whatever the arguments say,
 * and logged with `tool.called` like every other Squire tool.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId, SquireCreateInput, type SquireId, type ThreadId } from "@lecturn/contracts";
import { readHtmlRenderReference } from "@lecturn/shared/htmlRender";
import { htmlRenderFromToolItem } from "@lecturn/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Context from "effect/Context";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const billing = ProjectId.make("billing-service");

// Switch-on services, which the harness layer does not promise.
const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

// layerSquire registers the page tools; a temp Lecturn home has no browser
// installed, so publishing skips measuring.
const layerTest = phase4Layer;

interface Caller {
  readonly squireId: SquireId;
  readonly role: "lead" | "squire";
  readonly threadId: ThreadId;
}

const withSquires = <A, E>(
  body: (callers: ReadonlyArray<Caller>) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(billing, initRepo(`${root}/billing-service`));
      const service = yield* need(SquireService.SquireService);
      const squire = yield* service.create(
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
      return yield* body([
        { squireId: squire.id, role: "squire", threadId: squire.homeThreadId! },
        { squireId: lead.id, role: "lead", threadId: lead.homeThreadId! },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

const toolCalls = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listActionLog({ squireId, kinds: ["tool.called"], limit: 50 }),
  );

const LOCAL_PAGE = [
  '<img src="/Users/me/shot.png">',
  '<img srcset="/srv/a.webp 1x, C:\\pics\\b.avif 2x">',
  '<div style="background:url(/srv/bg.jpg)"></div>',
  '<script>const chart = "/srv/chart.svg";</script>',
  '<iframe src="file:///etc/passwd"></iframe>',
].join("");

const LOCAL_REFERENCES = [
  "/Users/me/shot.png",
  "/srv/a.webp",
  "C:\\pics\\b.avif",
  "/srv/bg.jpg",
  "/srv/chart.svg",
  "file:///etc/passwd",
];

describe("SquireHtmlTools", () => {
  it.effect("refuses every local file a Squire's page names, even when told not to", () =>
    withSquires((callers) =>
      Effect.gen(function* () {
        const tools = yield* need(SquireTools.SquireTools);
        for (const caller of callers) {
          assert.includeMembers(
            tools.definitions(caller.role).map((tool) => tool.name),
            ["html_render", "html_preview"],
          );
          // Arguments the schema does not know cannot switch the lock off.
          for (const [name, args] of [
            ["html_render", { html: LOCAL_PAGE, title: "Shots", height: 300, locked: false }],
            ["html_preview", { html: LOCAL_PAGE, locked: false, mode: "standard" }],
          ] as const) {
            const result = yield* tools.call(caller, name, args);
            assert.isTrue(result.isError, `${caller.role} ${name}`);
            for (const reference of LOCAL_REFERENCES) assert.include(result.text, reference);
          }
          const logged = yield* toolCalls(caller.squireId);
          assert.sameMembers(
            logged.map((row) => JSON.parse(row.data_json).tool),
            ["html_render", "html_preview"],
          );
        }
        const { attachmentsDir } = yield* ServerConfig;
        const pages = NodeFS.existsSync(attachmentsDir)
          ? NodeFS.readdirSync(attachmentsDir, { recursive: true }).filter((name) =>
              String(name).endsWith(".html"),
            )
          : [];
        assert.deepEqual(pages, []);
      }),
    ),
  );

  it.effect("publishes a Squire's page inside the locked wrapper and logs it", () =>
    withSquires(([squire]) =>
      Effect.gen(function* () {
        const tools = yield* need(SquireTools.SquireTools);
        const html = '<p>Revenue</p><img alt="" src="data:image/png;base64,iVBORw0KGgo=">';
        const result = yield* tools.call(squire!, "html_render", {
          html,
          title: "Revenue",
          height: 300,
        });
        assert.isFalse(result.isError, result.text);
        const reference = readHtmlRenderReference(
          (result.structuredContent as { htmlRender?: unknown }).htmlRender,
        )!;
        assert.deepEqual(JSON.parse(result.text).htmlRender, reference);
        // Web and mobile show it in the home thread as they show any agent's page.
        assert.deepEqual(
          htmlRenderFromToolItem({
            toolName: "mcp__lecturn__html_render",
            output: { content: [{ type: "text", text: result.text }] },
          }),
          reference,
        );

        const { attachmentsDir } = yield* ServerConfig;
        const stored = NodeFS.readFileSync(
          NodePath.join(attachmentsDir, `${reference.attachmentId}.html`),
          "utf8",
        );
        assert.match(
          stored,
          /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/,
        );
        assert.include(stored, "frame-src 'none'");
        // The page is data inside the wrapper, never markup of its own.
        assert.notInclude(stored, "<p>Revenue</p>");
        assert.include(stored, "\\u003cp>Revenue\\u003c/p>");

        const logged = yield* toolCalls(squire!.squireId);
        assert.lengthOf(logged, 1);
        assert.deepEqual(
          JSON.parse(logged[0]!.data_json).result.structuredContent.htmlRender,
          reference,
        );

        // A retried call in the same run returns the stored result, not a second page.
        const again = yield* tools.call(squire!, "html_render", {
          html,
          title: "Revenue",
          height: 300,
        });
        assert.strictEqual(again.text, result.text);
      }),
    ),
  );
});
