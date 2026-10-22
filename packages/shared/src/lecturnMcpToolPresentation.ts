export type LecturnMcpToolLogo = "lecturn";

export interface LecturnMcpToolPresentation {
  readonly displayName: string;
  readonly logo: LecturnMcpToolLogo;
}

export type LecturnMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface LecturnMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "lecturn" | "browser" | "device" | "pull-request";
  readonly summaryAction: LecturnMcpToolSummaryAction;
}

function tool(
  labels: LecturnMcpToolDefinition["labels"],
  summaryAction: LecturnMcpToolSummaryAction,
  icon: LecturnMcpToolDefinition["icon"] = "lecturn",
  displayName = `${labels[0]} ${labels[3]}`,
): LecturnMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const LECTURN_MCP_SERVER_ALIASES = new Set(["lecturn"]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const LECTURN_MCP_TOOLS: Readonly<Record<string, LecturnMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "Lecturn threads"], "thread-create"),
  lecturn_thread_start: tool(["Start", "Starting", "Started", "a Lecturn thread"], "thread-create"),
  lecturn_thread_list: tool(["List", "Listing", "Listed", "Lecturn threads"], "thread-list"),
  lecturn_thread_read: tool(["Read", "Reading", "Read", "a Lecturn thread"], "thread-read"),
  lecturn_thread_send: tool(["Send", "Sending", "Sent", "to a Lecturn thread"], "thread-send"),
  lecturn_thread_wait: tool(["Wait", "Waiting", "Waited", "for a Lecturn thread"], "thread-wait"),
  lecturn_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Lecturn thread"],
    "thread-interrupt",
  ),
  lecturn_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  lecturn_worktree_status: tool(
    ["Get", "Getting", "Got", "thread worktree status"],
    "worktree-status",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  lecturn_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  lecturn_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  lecturn_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  lecturn_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  lecturn_queue_reorder: tool(
    ["Reorder", "Reordering", "Reordered", "a queued run"],
    "queue-reorder",
  ),
  lecturn_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  lecturn_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  lecturn_pending_request_read: tool(
    ["Read", "Reading", "Read", "pending questions"],
    "question-read",
  ),
  lecturn_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  lecturn_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  lecturn_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  lecturn_thread_fork: tool(
    ["Fork", "Forking", "Requested a fork of", "this thread"],
    "thread-fork",
  ),
  lecturn_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  lecturn_thread_search: tool(
    ["Search", "Searching", "Searched", "thread content"],
    "thread-search",
  ),
  lecturn_thread_transfers: tool(
    ["Read", "Reading", "Read", "thread transfers"],
    "thread-transfers",
  ),
  lecturn_thread_organize: tool(
    ["Organize", "Organizing", "Organized", "a thread"],
    "thread-organize",
  ),
  lecturn_thread_update: tool(
    ["Update", "Updating", "Updated", "Lecturn thread metadata"],
    "thread-update",
  ),
  lecturn_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  lecturn_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  lecturn_preview_close: tool(
    ["Close", "Closing", "Closed", "a preview tab"],
    "browser",
    "browser",
  ),
  lecturn_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  lecturn_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  lecturn_thread_launch: tool(
    ["Launch", "Launching", "Launched", "a project thread"],
    "thread-create",
  ),
  lecturn_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  lecturn_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  lecturn_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  lecturn_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  lecturn_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  lecturn_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  lecturn_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  lecturn_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  lecturn_thread_send_attachments: tool(
    ["Send", "Sending", "Sent", "attachments"],
    "attachment-send",
  ),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

/**
 * The Lecturn orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const LECTURN_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(LECTURN_MCP_TOOLS));

function normalizeLecturnMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected Lecturn server prefixes its tools:
 * `mcp__lecturn__x` (Claude/Cursor), `lecturn.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveLecturnMcpToolName(value: string): string | null {
  const label = normalizeLecturnMcpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      LECTURN_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>lecturn)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  // Tool names share the server's "lecturn" prefix, so an exact name wins
  // before the separator form is stripped.
  if (Object.hasOwn(LECTURN_MCP_TOOLS, label)) return label;
  const prefixed = /^(?:mcp[-_]{1,2})?lecturn(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(LECTURN_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 registers one server per thread, `lecturn-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^lecturn-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(LECTURN_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

/** The bare Lecturn tool name (`html_render`) for any provider's spelling of it. */
export function resolveLecturnMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveLecturnMcpToolName(toolName);
  return name !== null && Object.hasOwn(LECTURN_MCP_TOOLS, name) ? name : null;
}

export function resolveLecturnMcpToolDefinition(
  toolName: string | null | undefined,
): LecturnMcpToolDefinition | null {
  const name = toolName == null ? null : resolveLecturnMcpToolName(toolName);
  return name !== null && Object.hasOwn(LECTURN_MCP_TOOLS, name) ? LECTURN_MCP_TOOLS[name]! : null;
}

export function resolveLecturnMcpToolPresentation(
  toolName: string | null | undefined,
): LecturnMcpToolPresentation | null {
  const definition = resolveLecturnMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "lecturn" };
}

export function resolveLecturnMcpToolSummaryAction(
  toolName: string | null | undefined,
): LecturnMcpToolSummaryAction | null {
  return resolveLecturnMcpToolDefinition(toolName)?.summaryAction ?? null;
}
