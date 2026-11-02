// @effect-diagnostics preferSchemaOverJson:off
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";
import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as SquireTools from "./SquireTools.ts";
import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";
import { connectMcp, serveBoundMcp } from "./testkit/boundMcp.ts";

const squireId = SquireId.make("squire-interceptor");
const homeThreadId = ThreadId.make("thread-squire-interceptor-home");
const normalThreadId = ThreadId.make("thread-squire-interceptor-ordinary");
const promise = <A>(run: () => Promise<A>) => Effect.promise(run);

const externalToken = "external-client-token";
const externalScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-squire-bound-mcp"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
  requestNamespace: "client-external",
  thread: undefined,
  client: { sessionId: "client-session", label: "External", access: "full-access" },
};

const ALL_SQUIRE_TOOLS = [...new Set([...SQUIRE_TOOL_NAMES.squire, ...SQUIRE_TOOL_NAMES.lead])];

interface StubCall {
  readonly caller: SquireTools.SquireToolCaller;
  readonly name: string;
  readonly args: unknown;
}

/** Answers every role tool; `refuse: true` in the arguments returns a tool-level refusal. */
const makeStub = () => {
  const calls: Array<StubCall> = [];
  const service = SquireTools.SquireTools.of({
    definitions: (role) =>
      SQUIRE_TOOL_NAMES[role].map((name) => ({
        name,
        description: `Stub ${name}.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      })),
    call: (caller, name, args) =>
      Effect.sync(() => {
        calls.push({ caller, name, args });
        const refused = (args as { readonly refuse?: boolean } | undefined)?.refuse === true;
        return refused
          ? { isError: true, text: `Refused ${name}.` }
          : { isError: false, text: `Stub answered ${name}.`, structuredContent: { tool: name } };
      }),
  });
  return { calls, service };
};

const isGateRefusal = (answer: Record<string, unknown> | undefined) =>
  String((answer?.error as { message?: unknown } | undefined)?.message ?? "").endsWith(
    "is not available on this thread.",
  );

type ToolResult = {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent?: unknown;
};

const withBound = <A, E>(
  options: { readonly squireEnabled: boolean; readonly withTools: boolean },
  body: (
    bound: Effect.Success<ReturnType<typeof serveBoundMcp>>,
    stub: ReturnType<typeof makeStub>,
  ) => Effect.Effect<A, E>,
) => {
  const stub = makeStub();
  return Effect.scoped(
    Effect.flatMap(
      serveBoundMcp({
        squireEnabled: options.squireEnabled,
        squireTools: options.withTools ? stub.service : undefined,
        externalClient: { token: externalToken, scope: externalScope },
      }),
      (bound) => body(bound, stub),
    ),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));
};

const externalConfig = (normal: McpProviderSessionConfig): McpProviderSessionConfig => ({
  ...normal,
  authorizationHeader: `Bearer ${externalToken}`,
});

/** Every tool the production `/mcp` registers, as an ordinary thread lists it. */
const listRegistered = (normal: McpProviderSessionConfig) =>
  promise(async () => (await connectMcp(normal)).listToolNames());

describe("SquireToolInterceptor on the bound /mcp", () => {
  it.live.each(["squire", "lead"] as const)(
    "a %s credential lists and calls only its role allowlist",
    (role) =>
      withBound({ squireEnabled: true, withTools: true }, (bound, stub) =>
        Effect.gen(function* () {
          const registered = yield* listRegistered(yield* bound.issueNormal(normalThreadId));
          assert.isAbove(registered.length, 20);
          const roleTools: ReadonlyArray<string> = SQUIRE_TOOL_NAMES[role];
          const expected = role === "lead" ? ["html_render", ...roleTools] : roleTools;

          const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role });
          const client = yield* promise(() => connectMcp(config));
          assert.deepEqual(
            [...(yield* promise(() => client.listToolNames()))].sort(),
            [...expected].sort(),
          );

          for (const name of roleTools) {
            const { answer } = yield* promise(() => client.callTool(name, { probe: name }));
            const result = answer?.result as ToolResult | undefined;
            assert.isFalse(result?.isError, `${name}: ${JSON.stringify(answer)}`);
            assert.equal(result?.content?.[0]?.text, `Stub answered ${name}.`);
            assert.deepEqual(result?.structuredContent, { tool: name });
          }
          assert.deepEqual(
            stub.calls,
            roleTools.map((name) => ({
              caller: { squireId, role, threadId: homeThreadId },
              name,
              args: { probe: name },
            })),
          );

          // A refusal is a tool result the model reads, not a protocol error.
          const refused = yield* promise(() => client.callTool(roleTools[0]!, { refuse: true }));
          const refusedResult = refused.answer?.result as ToolResult | undefined;
          assert.isTrue(refusedResult?.isError);
          assert.equal(refusedResult?.content?.[0]?.text, `Refused ${roleTools[0]}.`);

          const callsBefore = stub.calls.length;
          const outside = [
            ...registered.filter((name) => !expected.includes(name)),
            ...ALL_SQUIRE_TOOLS.filter((name) => !roleTools.includes(name)),
          ];
          for (const name of outside) {
            const { answer } = yield* promise(() => client.callTool(name, {}));
            assert.isTrue(isGateRefusal(answer), `${role} ${name}: ${JSON.stringify(answer)}`);
          }
          assert.equal(stub.calls.length, callsBefore);
        }),
      ),
  );

  it.live("ordinary thread and external client credentials see and reach no Squire tool", () =>
    withBound({ squireEnabled: true, withTools: true }, (bound, stub) =>
      Effect.gen(function* () {
        const normal = yield* bound.issueNormal(normalThreadId);
        for (const config of [normal, externalConfig(normal)]) {
          const client = yield* promise(() => connectMcp(config));
          const names = yield* promise(() => client.listToolNames());
          assert.include(names, "lecturn_thread_list");
          assert.isEmpty(names.filter((name) => name.startsWith("squire_")));
          for (const name of ALL_SQUIRE_TOOLS) {
            const { answer } = yield* promise(() => client.callTool(name, {}));
            assert.isDefined(answer?.error, `${name}: ${JSON.stringify(answer)}`);
            assert.isUndefined(answer?.result);
          }
        }
        assert.deepEqual(stub.calls, []);
      }),
    ),
  );

  it.live.each([
    ["switch off, tools present", { squireEnabled: false, withTools: true }],
    ["switch off, tools absent", { squireEnabled: false, withTools: false }],
  ] as const)("with the %s, a Squire credential lists and calls nothing", ([, options]) =>
    withBound(options, (bound, stub) =>
      Effect.gen(function* () {
        for (const role of ["squire", "lead"] as const) {
          const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role });
          const client = yield* promise(() => connectMcp(config));
          assert.deepEqual(yield* promise(() => client.listToolNames()), []);
          for (const name of [...ALL_SQUIRE_TOOLS, "html_render"]) {
            const { answer } = yield* promise(() => client.callTool(name, {}));
            assert.isTrue(isGateRefusal(answer), `${role} ${name}: ${JSON.stringify(answer)}`);
          }
        }
        assert.deepEqual(stub.calls, []);
      }),
    ),
  );
});
