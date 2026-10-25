// @effect-diagnostics nodeBuiltinImport:off -- Test-side client for a server the e2e launched.
/**
 * The scenario's stand-in for a signed-in Lecturn client: a bearer session
 * written offline into the server's own base dir (`lecturn auth session
 * issue`), used over `/ws` for what a user would do from Settings or the
 * composer's mode picker.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { embedHostDir } from "../scripts/electronLauncher.ts";
import { ticketedSocketUrl } from "./embedRpc.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** The built server the sidecar runs, so the CLI writes the schema that server reads. */
const lecturnBin = () =>
  NodeModule.createRequire(NodePath.join(embedHostDir, "package.json")).resolve(
    "lecturn/dist/bin.mjs",
  );

export const ADMIN_SCOPES = ["access:write", "orchestration:read", "orchestration:operate"];

export async function issueAdminToken(baseDir: string): Promise<string> {
  const { stdout } = await execFile(process.execPath, [
    lecturnBin(),
    "auth",
    "session",
    "issue",
    "--base-dir",
    baseDir,
    ...ADMIN_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--label",
    "embed-host e2e admin",
    "--token-only",
  ]);
  const token = stdout.trim();
  if (token.length === 0 || /\s/.test(token)) {
    throw new Error(`auth session issue printed no single token: ${JSON.stringify(stdout)}`);
  }
  return token;
}

// The two methods this client calls, as the server mounts them in WsRpcGroup.
const AdminGroup = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
    success: OrchestrationV2RpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  }),
);

export interface AdminClient {
  setRuntimeMode(threadId: string, runtimeMode: RuntimeMode): Promise<void>;
  threadProjection(threadId: string): Promise<OrchestrationV2ThreadProjection>;
}

export function adminClient(input: { readonly origin: string; readonly token: string }) {
  // A socket per call: each call is short, and nothing is left open when a run fails.
  const connect = async () => {
    const url = await ticketedSocketUrl(input.origin, input.token);
    const protocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
          RpcSerialization.layerJson,
        ),
      ),
    );
    // Built into the caller's scope: `Effect.provide` would close the socket
    // as soon as the client is made.
    return Layer.build(protocol).pipe(
      Effect.flatMap((context) => RpcClient.make(AdminGroup).pipe(Effect.provideContext(context))),
    );
  };

  return {
    async setRuntimeMode(threadId, runtimeMode) {
      const client = await connect();
      await Effect.runPromise(
        client.pipe(
          Effect.flatMap((rpc) =>
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`embed-host-e2e:${NodeCrypto.randomUUID()}`),
              threadId: ThreadId.make(threadId),
              runtimeMode,
            }),
          ),
          Effect.scoped,
        ),
      );
    },
    async threadProjection(threadId) {
      const client = await connect();
      return Effect.runPromise(
        client.pipe(
          Effect.flatMap((rpc) =>
            rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make(threadId),
            }),
          ),
          Effect.scoped,
        ),
      );
    },
  } satisfies AdminClient;
}
