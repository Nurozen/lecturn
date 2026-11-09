import type { ProviderInteractionMode } from "@lecturn/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const LECTURN_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## Lecturn orchestration

Ordinary coding tasks need no Lecturn tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`lecturn_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`lecturn_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`lecturn_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`lecturn_thread_read\` it before you answer about it.
- Another machine: \`lecturn_environment_links\` lists linked ones. Pass its \`environmentId\` to a Lecturn tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`lecturn_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a Lecturn tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- Lecturn tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const LECTURN_ORCHESTRATION_INSTRUCTIONS = `

${LECTURN_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const LECTURN_BROWSER_TOOL_INSTRUCTIONS = `

## Lecturn browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const LECTURN_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## Lecturn devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const LECTURN_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const LECTURN_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${LECTURN_DEVICE_TOOLS.map((tool) => `mcp__lecturn__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const LECTURN_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the Lecturn tools are absent and \`LECTURN_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$LECTURN_ACP_MCP_NODE" \${LECTURN_ACP_MCP_ENTRYPOINT:+"$LECTURN_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`LECTURN_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const LECTURN_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Lecturn interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Lecturn supplies a different interaction-mode instruction.`;

const LECTURN_ACP_PLAN_MODE_INSTRUCTIONS = `## Lecturn interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until Lecturn supplies a different interaction-mode instruction.`;

export interface LecturnAcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasLecturnMcp: boolean;
  readonly hasDeviceTools: boolean;
  /**
   * Lecturn: a digest of the connected app's instructions, so a changed
   * registration re-sends them while an unchanged one is not repeated.
   */
  readonly appInstructionsHash?: string;
  /** Lecturn: likewise for a Squire home's skill. */
  readonly squireInstructionsHash?: string;
}

/**
 * Lecturn: on a Squire home the skill replaces the orchestration, browser,
 * and device sections, which steer to tools its credential never lists.
 * `undefined` on every other thread.
 */
export function squireInstructionsText(
  squireInstructions: ReadonlyArray<string> | undefined,
): string | undefined {
  return squireInstructions === undefined || squireInstructions.length === 0
    ? undefined
    : squireInstructions.join("\n\n");
}

/**
 * Lecturn: how every adapter labels a connected app's registered
 * instructions. `undefined` when the thread's app registered none.
 */
export function connectedAppInstructionsSection(
  appInstructions: string | undefined,
): string | undefined {
  const text = appInstructions?.trim();
  return text ? `## Connected app instructions\n\n${text}` : undefined;
}

/** FNV-1a; only ever compared with the previous turn's value for the same session. */
function instructionsDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function lecturnAcpInstructionState(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasLecturnMcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly appInstructions?: string;
  readonly squireInstructions?: ReadonlyArray<string>;
}): LecturnAcpInstructionState {
  const section = connectedAppInstructionsSection(input.appInstructions);
  const squire = squireInstructionsText(input.squireInstructions);
  return {
    interactionMode: input.interactionMode,
    hasLecturnMcp: input.hasLecturnMcp,
    hasDeviceTools: input.hasDeviceTools,
    ...(section === undefined ? {} : { appInstructionsHash: instructionsDigest(section) }),
    ...(squire === undefined ? {} : { squireInstructionsHash: instructionsDigest(squire) }),
  };
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function lecturnAcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: LecturnAcpInstructionState;
  readonly previousState?: LecturnAcpInstructionState;
  /** The text `state.appInstructionsHash` was computed from. */
  readonly appInstructions?: string;
  /** The sections `state.squireInstructionsHash` was computed from. */
  readonly squireInstructions?: ReadonlyArray<string>;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasLecturnMcp === input.state.hasLecturnMcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools &&
    input.previousState.appInstructionsHash === input.state.appInstructionsHash &&
    input.previousState.squireInstructionsHash === input.state.squireInstructionsHash
  ) {
    return input.prompt;
  }
  const appSection =
    input.state.appInstructionsHash === undefined
      ? undefined
      : connectedAppInstructionsSection(input.appInstructions);
  const squire =
    input.state.squireInstructionsHash === undefined
      ? undefined
      : squireInstructionsText(input.squireInstructions);
  const instructions = [
    input.state.interactionMode === "plan"
      ? LECTURN_ACP_PLAN_MODE_INSTRUCTIONS
      : LECTURN_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(squire !== undefined
      ? [squire]
      : input.state.hasLecturnMcp
        ? [
            LECTURN_BROWSER_TOOL_INSTRUCTIONS.trim(),
            ...(input.state.hasDeviceTools ? [LECTURN_DEVICE_TOOL_INSTRUCTIONS] : []),
            LECTURN_ORCHESTRATION_INSTRUCTIONS.trim(),
            LECTURN_ACP_MCP_FALLBACK_INSTRUCTIONS,
          ]
        : []),
    ...(appSection === undefined ? [] : [appSection]),
  ];
  return `<lecturn_instructions>\n${instructions.join("\n\n")}\n</lecturn_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${LECTURN_ORCHESTRATION_INSTRUCTIONS}\n${LECTURN_DEVICE_TOOL_INSTRUCTIONS}\n`
    : LECTURN_ORCHESTRATION_INSTRUCTIONS;

function prependLecturnOrchestrationInstructions(prompt: string, instructions: string): string {
  return `<lecturn_orchestration_instructions>${instructions.trim()}</lecturn_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function lecturnOrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasLecturnMcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  readonly squireInstructions?: ReadonlyArray<string>;
}): string {
  // Lecturn: a Squire home's skill replaces the orchestration and device sections.
  const squire = squireInstructionsText(input.squireInstructions);
  if (squire !== undefined) {
    return input.orchestrationDelivered
      ? input.prompt
      : prependLecturnOrchestrationInstructions(input.prompt, squire);
  }
  if (!input.hasLecturnMcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependLecturnOrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependLecturnOrchestrationInstructions(input.prompt, LECTURN_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function lecturnOrchestrationSystemPrompt(
  hasLecturnMcp: boolean,
  hasDeviceTools: boolean,
  squireInstructions?: ReadonlyArray<string>,
): string | undefined {
  return (
    squireInstructionsText(squireInstructions) ??
    (hasLecturnMcp ? orchestrationInstructions(hasDeviceTools) : undefined)
  );
}
