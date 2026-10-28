import { assert, describe, it } from "@effect/vitest";

import {
  LECTURN_ORCHESTRATION_INSTRUCTIONS,
  lecturnAcpInstructionState,
  lecturnAcpPromptWithInstructions,
  lecturnOrchestrationPromptForFirstRun,
  lecturnOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Lecturn orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Lecturn conversations");
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      LECTURN_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `lecturn_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(LECTURN_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = lecturnOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasLecturnMcp: true,
    });

    assert.include(injected, "<lecturn_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      lecturnOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasLecturnMcp: true }),
      prompt,
    );
    assert.equal(
      lecturnOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasLecturnMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Lecturn MCP server is attached", () => {
    assert.equal(lecturnOrchestrationSystemPrompt(false), undefined);
    assert.equal(lecturnOrchestrationSystemPrompt(true), LECTURN_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = lecturnAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasLecturnMcp: true },
    });

    assert.include(injected, "Lecturn interaction mode: Default");
    assert.include(injected, "Lecturn collaborative browser");
    assert.include(injected, "Lecturn orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasLecturnMcp: true } as const;

    assert.equal(
      lecturnAcpPromptWithInstructions({
        prompt,
        state: defaultState,
        previousState: defaultState,
      }),
      prompt,
    );
    assert.include(
      lecturnAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Lecturn interaction mode: Plan",
    );
    const withoutMcp = lecturnAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasLecturnMcp: false },
    });
    assert.include(withoutMcp, "Lecturn interaction mode: Default");
    assert.notInclude(withoutMcp, "Lecturn collaborative browser");
    assert.notInclude(withoutMcp, "Lecturn orchestration");
  });

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
});
