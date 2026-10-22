// GitHub Copilot CLI 1.0.x `--acp` text-generation wire contract (ACP v1), kept
// independent of the v2 mock: no model state (the model goes through
// session/set_model), `copilot-login` auth, underscore permission option ids.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "copilot-text-session";
const emitToolCalls = process.env.LECTURN_ACP_EMIT_TOOL_CALLS === "1";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (update) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let nextAgentRequestId = 1_000;
/** Prompt waiting on the client's answer to a permission request. */
let pendingPrompt;

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  if (line.trim().length === 0) continue;
  const message = JSON.parse(line);
  if (process.env.LECTURN_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.LECTURN_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (message.method === undefined) {
    // The client's answer to our permission request: the tool never runs.
    if (pendingPrompt !== undefined && message.id === pendingPrompt.permissionRequestId) {
      const optionId = message.result?.outcome?.optionId;
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-call-1",
        status: optionId === "reject_once" ? "failed" : "completed",
      });
      write({ jsonrpc: "2.0", id: pendingPrompt.id, result: { stopReason: "end_turn" } });
      pendingPrompt = undefined;
    }
    continue;
  }
  if (message.id === undefined) continue;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "Copilot", version: "mock" },
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "copilot-login", name: "Log in with Copilot CLI" }],
      };
      break;
    case "authenticate":
      if (message.params?.methodId !== "copilot-login") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Mock Copilot rejected auth method ${message.params?.methodId}.`,
          },
        });
        continue;
      }
      result = {};
      break;
    case "session/new":
      result = { sessionId };
      break;
    case "session/set_model":
      // Copilot accepts any model id it can route; the request log records it.
      result = {};
      break;
    case "session/prompt":
      if (emitToolCalls) {
        notify({
          sessionUpdate: "tool_call",
          toolCallId: "tool-call-1",
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: { command: ["cat", "server/package.json"] },
        });
        const permissionRequestId = nextAgentRequestId++;
        pendingPrompt = { id: message.id, permissionRequestId };
        write({
          jsonrpc: "2.0",
          id: permissionRequestId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: "tool-call-1",
              title: "Terminal",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        continue;
      }
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: process.env.LECTURN_ACP_PROMPT_RESPONSE_TEXT ?? "" },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: message.id, result });
}
