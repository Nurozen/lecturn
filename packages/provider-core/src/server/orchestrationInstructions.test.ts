import { assert, describe, it } from "@effect/vitest";

import {
  LECTURN_ORCHESTRATION_INSTRUCTIONS,
  lecturnAcpInstructionState,
  lecturnAcpPromptWithInstructions,
  lecturnOrchestrationPromptForFirstRun,
  lecturnOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Lecturn orchestration provider instructions", () => {
  it("sends a connected app's instructions once, and again when they change", () => {
    const prompt = "Fly the rocket.";
    const appInstructions = "Use rw_ tools for rocket edits.";
    const state = lecturnAcpInstructionState({
      interactionMode: "default",
      hasLecturnMcp: true,
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
    assert.deepEqual(lecturnAcpInstructionState({ interactionMode: "plan", hasLecturnMcp: true }), {
      interactionMode: "plan",
      hasLecturnMcp: true,
    });
    assert.deepEqual(
      lecturnAcpInstructionState({
        interactionMode: "plan",
        hasLecturnMcp: true,
        appInstructions: "  ",
      }),
      { interactionMode: "plan", hasLecturnMcp: true },
    );
  });

  it("sends a Squire home its skill in place of the browser and orchestration sections", () => {
    const prompt = "Squire events · 1 event";
    const squireInstructions = ["## Squire\n\nStay quiet by default.", "### Steers\n\nOne action."];
    const state = lecturnAcpInstructionState({
      interactionMode: "default",
      hasLecturnMcp: true,
      squireInstructions,
    });
    const first = lecturnAcpPromptWithInstructions({ prompt, state, squireInstructions });
    assert.include(first, squireInstructions.join("\n\n"));
    assert.notInclude(first, LECTURN_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(first, "## Lecturn collaborative browser");
    assert.equal(
      lecturnAcpPromptWithInstructions({ prompt, state, previousState: state, squireInstructions }),
      prompt,
    );

    assert.equal(
      lecturnOrchestrationSystemPrompt(true, squireInstructions),
      squireInstructions.join("\n\n"),
    );
    assert.include(
      lecturnOrchestrationPromptForFirstRun({
        prompt,
        runOrdinal: 1,
        hasLecturnMcp: true,
        squireInstructions,
      }),
      "Stay quiet by default.",
    );
  });
});
