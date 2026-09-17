import * as Schema from "effect/Schema";

export const RelayTeamRole = Schema.Literals(["owner", "admin", "member"]);
export type RelayTeamRole = typeof RelayTeamRole.Type;
export const RelayTeamPolicy = Schema.Struct({
  allowedProviders: Schema.NullOr(Schema.Array(Schema.String)),
  publishAgentActivity: Schema.Boolean,
});
export type RelayTeamPolicy = typeof RelayTeamPolicy.Type;
export const RelayTeamOrganization = Schema.Struct({
  organizationId: Schema.String,
  name: Schema.String,
  role: RelayTeamRole,
  purchasedSeats: Schema.Number,
  assignedSeats: Schema.Number,
  hasSeat: Schema.Boolean,
  hasAccess: Schema.Boolean,
  policy: RelayTeamPolicy,
});
export type RelayTeamOrganization = typeof RelayTeamOrganization.Type;
export const RelayTeamSeat = Schema.Struct({ userId: Schema.String, assignedAt: Schema.Number });
export type RelayTeamSeat = typeof RelayTeamSeat.Type;
export const RelayTeamEnvironment = Schema.Struct({
  userId: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["linked", "unlinked"]),
});
export type RelayTeamEnvironment = typeof RelayTeamEnvironment.Type;
