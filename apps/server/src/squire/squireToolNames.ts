import type { SquireRole } from "@lecturn/contracts";

const READ_TOOLS = ["squire_list_tracked", "squire_get_summary"] as const;

/** Lecturn's page tools, which a Squire gets locked down (`SquireHtmlTools`). */
const HTML_TOOLS = ["html_preview", "html_render"] as const;

/**
 * The Squire role tools each role may call; `definitions` lists
 * only the names that have a handler.
 * The Lead never reads raw thread history, so it has no `squire_get_detail`.
 */
export const SQUIRE_TOOL_NAMES = {
  squire: [
    ...READ_TOOLS,
    "squire_get_detail",
    "squire_recommend_steer",
    "squire_send_steer",
    "squire_propose_thread",
    "squire_create_thread",
    "squire_notify",
    "squire_send_message",
    "squire_propose_room",
    "squire_read_room",
    "squire_stay_quiet",
    ...HTML_TOOLS,
  ],
  lead: [
    ...READ_TOOLS,
    "squire_list_items",
    "squire_raise_overlap",
    "squire_propose_squire",
    "squire_pause",
    "squire_resume",
    "squire_rescope",
    "squire_forward_item",
    "squire_merge_items",
    "squire_recommend_steer",
    "squire_send_steer",
    "squire_route_task",
    "squire_propose_thread",
    "squire_publish_showcase",
    "squire_notify",
    "squire_send_message",
    "squire_open_room",
    "squire_close_room",
    "squire_read_room",
    "squire_stay_quiet",
    ...HTML_TOOLS,
  ],
} as const satisfies Record<SquireRole, ReadonlyArray<string>>;

export type SquireToolName = (typeof SQUIRE_TOOL_NAMES)[SquireRole][number];
