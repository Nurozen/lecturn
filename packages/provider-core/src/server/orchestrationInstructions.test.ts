import { assert, describe, it } from "@effect/vitest";

import {
  LECTURN_DEVICE_TOOL_INSTRUCTIONS,
  LECTURN_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  LECTURN_ORCHESTRATION_INSTRUCTIONS,
  lecturnAcpInstructionState,
  lecturnAcpPromptWithInstructions,
  lecturnOrchestrationPrompt,
  lecturnOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Lecturn orchestration provider instructions", () => {
  it("sends a connected app's instructions once, and again when they change", () => {
    const prompt = "Fly the rocket.";
    const appInstructions = "Use rw_ tools for rocket edits.";
    const state = lecturnAcpInstructionState({
      interactionMode: "default",
      hasLecturnMcp: true,
      hasDeviceTools: false,
      appInstructions,
    });

    const first = lecturnAcpPromptWithInstructions({ prompt, state, appInstructions });
    assert.include(first, `## Connected app instructions\n\n${appInstructions}`);
    assert.equal(
      lecturnAcpPromptWithInstructions({ prompt, state, previousState: state, appInstructions }),
      prompt,
    );

    // A new session has no previous state, so a restart or compaction re-sends them.
    const changed = "Use rw_ tools; never edit .ork files by hand.";
    const changedState = lecturnAcpInstructionState({
      interactionMode: "default",
      hasLecturnMcp: true,
      hasDeviceTools: false,
      appInstructions: changed,
    });
    assert.include(
      lecturnAcpPromptWithInstructions({
        prompt,
        state: changedState,
        previousState: state,
        appInstructions: changed,
      }),
      changed,
    );

    // Threads outside an app keep the state, and so the bytes, they had.
    assert.deepEqual(
      lecturnAcpInstructionState({
        interactionMode: "plan",
        hasLecturnMcp: true,
        hasDeviceTools: false,
      }),
      { interactionMode: "plan", hasLecturnMcp: true, hasDeviceTools: false },
    );
    assert.deepEqual(
      lecturnAcpInstructionState({
        interactionMode: "plan",
        hasLecturnMcp: true,
        hasDeviceTools: false,
        appInstructions: "  ",
      }),
      { interactionMode: "plan", hasLecturnMcp: true, hasDeviceTools: false },
    );
  });

  it("sends a Squire home its skill in place of the browser and orchestration sections", () => {
    const prompt = "Squire events · 1 event";
    const squireInstructions = ["## Squire\n\nStay quiet by default.", "### Steers\n\nOne action."];
    const state = lecturnAcpInstructionState({
      interactionMode: "default",
      hasLecturnMcp: true,
      hasDeviceTools: true,
      squireInstructions,
    });
    const first = lecturnAcpPromptWithInstructions({ prompt, state, squireInstructions });
    assert.include(first, squireInstructions.join("\n\n"));
    assert.notInclude(first, LECTURN_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(first, "## Lecturn browser");
    assert.notInclude(first, "## Lecturn devices");
    assert.notInclude(first, "acp-mcp-call");
    assert.equal(
      lecturnAcpPromptWithInstructions({ prompt, state, previousState: state, squireInstructions }),
      prompt,
    );

    assert.equal(
      lecturnOrchestrationSystemPrompt(true, true, squireInstructions),
      squireInstructions.join("\n\n"),
    );
    assert.include(
      lecturnOrchestrationPrompt({
        prompt,
        hasLecturnMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
        squireInstructions,
      }),
      "Stay quiet by default.",
    );
  });
});

describe("Lecturn device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(LECTURN_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(LECTURN_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__lecturn__device_list,mcp__lecturn__device_open,mcp__lecturn__device_screenshot,mcp__lecturn__device_close`.";
    assert.include(LECTURN_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      LECTURN_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      LECTURN_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      LECTURN_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      LECTURN_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(lecturnOrchestrationSystemPrompt(true, true), LECTURN_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(lecturnOrchestrationSystemPrompt(true, false), "## Lecturn devices");
    assert.isUndefined(lecturnOrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      lecturnOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLecturnMcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), LECTURN_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Lecturn devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      lecturnOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLecturnMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), LECTURN_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), LECTURN_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = {
      interactionMode: "default",
      hasLecturnMcp: true,
      hasDeviceTools: false,
    } as const;
    const withDevices = lecturnAcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, LECTURN_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      lecturnAcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      lecturnAcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## Lecturn devices",
    );
  });
});
