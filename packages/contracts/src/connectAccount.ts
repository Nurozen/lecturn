import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const ConnectAccount = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  email: Schema.optionalKey(Schema.String),
});
export type ConnectAccount = typeof ConnectAccount.Type;
export const ConnectAccountStatus = Schema.Struct({
  configured: Schema.Boolean,
  state: Schema.Literals(["signed-out", "authorizing", "signed-in", "error"]),
  account: Schema.NullOr(ConnectAccount),
  relayUrl: Schema.NullOr(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type ConnectAccountStatus = typeof ConnectAccountStatus.Type;
export const ConnectAccountBeginResult = Schema.Struct({
  authorizationUrl: Schema.String,
  requestId: Schema.String,
  expiresAt: Schema.String,
});
export type ConnectAccountBeginResult = typeof ConnectAccountBeginResult.Type;
const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ConnectAccountCompleteRequest = Schema.Struct({
  requestId: RequestId,
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});
export const ConnectAccountCancelRequest = Schema.Struct({ requestId: RequestId });
export const ConnectAccountTokenRequest = Schema.Struct({ accountId: ConnectAccount.fields.id });
export const ConnectAccountTokenResult = Schema.Struct({ token: Schema.NullOr(Schema.String) });
export type ConnectAccountTokenResult = typeof ConnectAccountTokenResult.Type;
export class ConnectAccountError extends Schema.TaggedErrorClass<ConnectAccountError>()(
  "ConnectAccountError",
  {
    reason: Schema.Literals([
      "local_ui_required",
      "not_configured",
      "login_in_progress",
      "already_signed_in",
      "invalid_request",
      "authorization_failed",
      "credential_unavailable",
      "account_mismatch",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ConnectAccountError)(this, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}
