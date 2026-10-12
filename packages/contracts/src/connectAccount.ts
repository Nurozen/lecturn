import * as Schema from "effect/Schema";

export const ConnectAccount = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  email: Schema.optionalKey(Schema.String),
});
export type ConnectAccount = typeof ConnectAccount.Type;
export const ConnectAccountStatus = Schema.Struct({
  configured: Schema.Boolean,
  state: Schema.Literals(["loading", "signed-out", "authorizing", "signed-in", "error"]),
  account: Schema.NullOr(ConnectAccount),
  relayUrl: Schema.NullOr(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type ConnectAccountStatus = typeof ConnectAccountStatus.Type;
export const ConnectAccountTokenRequest = Schema.Struct({ accountId: ConnectAccount.fields.id });

/** Short-lived native SDK token; never persisted by the web client. */
export const ConnectAccountTokenResult = Schema.Struct({ token: Schema.NullOr(Schema.String) });
export type ConnectAccountTokenResult = typeof ConnectAccountTokenResult.Type;
