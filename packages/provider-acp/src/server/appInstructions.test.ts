import { assert, describe, it } from "@effect/vitest";

import { acpAppInstructions } from "./appInstructions.ts";

const app = {
  appId: "dev.example.embedhost",
  toolPrefix: "ex",
  toolNames: ["ex_counter_increment", "ex_window_flash"],
};
const grokName = (tool: string) => `lecturn__${tool}`;

describe("acpAppInstructions", () => {
  it("names the app's tools in the agent's qualified form after its instructions", () => {
    assert.equal(
      acpAppInstructions({
        instructions: "You can read and increment a counter and flash the host window.",
        app,
        toolName: grokName,
      }),
      "You can read and increment a counter and flash the host window.\n\n" +
        "Call this app's tools by these exact names: `lecturn__ex_counter_increment`, `lecturn__ex_window_flash`.",
    );
  });

  it("gives the qualified prefix when no tool names were cached yet", () => {
    assert.equal(
      acpAppInstructions({
        instructions: undefined,
        app: { ...app, toolNames: [] },
        toolName: grokName,
      }),
      "Call this app's tools by their full names, which start with `lecturn__ex_`.",
    );
  });

  it("names the server and bare tools when the agent's form is unknown", () => {
    assert.equal(
      acpAppInstructions({ instructions: "  ", app, toolName: undefined }),
      "This app's tools are on the `lecturn` MCP server: `ex_counter_increment`, `ex_window_flash`. " +
        "Call each by the name your tool list shows for it, which may add the server's prefix.",
    );
  });

  it("leaves a thread with no app as it was", () => {
    assert.equal(
      acpAppInstructions({ instructions: "Be brief.", app: undefined, toolName: grokName }),
      "Be brief.",
    );
    assert.isUndefined(
      acpAppInstructions({ instructions: undefined, app: undefined, toolName: grokName }),
    );
  });
});
