/**
 * Asks the user to approve one app tool call and waits for the answer. The
 * request id travels back to the app in `lecturn/approval` on the re-sent call.
 *
 * Anything but an approval with a raised request refuses the call: a call
 * that needs approval never runs without one.
 */
import type { ConnectedAppToolApprovalInfo } from "@lecturn/contracts";
import * as Effect from "effect/Effect";

import { refusalMessage } from "../../../apps/AppToolApprovalService.ts";
import { AppToolApprovalService } from "../../../apps/services.ts";
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

export const make = Effect.gen(function* () {
  const approvals = yield* AppToolApprovalService;
  const request: RequestAppToolApproval = ({ scope, info }) =>
    approvals
      .request(
        { threadId: scope.thread.threadId, providerSessionId: scope.thread.providerSessionId },
        info,
      )
      .pipe(
        Effect.map(({ outcome, requestId }): AppToolApprovalResult =>
          outcome === "approved" && requestId !== null
            ? { approved: true, requestId }
            : {
                approved: false,
                message: refusalMessage(
                  info.toolName,
                  outcome === "approved" ? "cancelled" : outcome,
                ),
              },
        ),
        Effect.catch((error) =>
          Effect.succeed<AppToolApprovalResult>({ approved: false, message: error.message }),
        ),
      );
  return request;
});
