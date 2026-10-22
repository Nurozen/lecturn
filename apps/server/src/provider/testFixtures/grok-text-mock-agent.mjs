// Native Grok's v1 model-selection wire contract, kept independent of the v2 mock.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-text-session";
let currentModelId = "grok-mock-default";
const models = ["grok-mock-default", "grok-mock-alt"];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.LECTURN_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.LECTURN_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "grok", version: "mock" },
        agentCapabilities: {},
      };
      break;
    case "session/new":
      result = {
        sessionId,
        models: {
          currentModelId,
          availableModels: models.map((modelId) => ({ modelId, name: modelId })),
        },
      };
      break;
    case "session/set_model":
      if (!models.includes(request.params.modelId)) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown Grok model" },
        });
        continue;
      }
      currentModelId = request.params.modelId;
      result = {};
      break;
    case "session/prompt":
      if (process.env.LECTURN_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1") {
        // The harness runs a tool between assistant chunks (text inference must not).
        const update = (body) =>
          write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "before tool" },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-call-1",
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: { command: ["echo", "hello"] },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-call-1",
          status: "completed",
          rawOutput: { exitCode: 0, stdout: "hello", stderr: "" },
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.LECTURN_ACP_PROMPT_RESPONSE_TEXT ?? "" },
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
