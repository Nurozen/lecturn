/**
 * Asks the user to approve one app tool call and waits for the answer. The
 * request id travels back to the app in `lecturn/approval` on the re-sent call.
 *
 * Stub until A20 wires AppToolApprovalService: every request is refused, so a
 * call that needs approval never runs without one.
 */
import type { ConnectedAppToolApprovalInfo } from "@lecturn/contracts";
import * as Effect from "effect/Effect";

import type { McpAppInvocationScope } from "../../McpInvocationContext.ts";

export interface AppToolApprovalRequest {
  readonly scope: McpAppInvocationScope;
  readonly info: ConnectedAppToolApprovalInfo;
}

export type AppToolApprovalResult =
  | { readonly approved: true; readonly requestId: string }
  | { readonly approved: false; readonly message: string };

export type RequestAppToolApproval = (
  request: AppToolApprovalRequest,
) => Effect.Effect<AppToolApprovalResult>;

export const make = Effect.succeed<RequestAppToolApproval>(({ info }) =>
  Effect.succeed({
    approved: false,
    message: `${info.toolName} needs approval, which this Lecturn server cannot ask for yet.`,
  }),
);
