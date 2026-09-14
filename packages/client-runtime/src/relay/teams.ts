import {
  RelayTeamOrganization,
  RelayTeamPolicy,
  RelayTeamRole,
  RelayTeamEnvironment,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { normalizeSecureRelayUrl } from "@lecturn/shared/relayUrl";

const TeamDetail = Schema.Struct({
  organization: RelayTeamOrganization,
  members: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      email: Schema.String,
      name: Schema.String,
      role: RelayTeamRole,
      hasSeat: Schema.Boolean,
    }),
  ),
  invitations: Schema.Array(
    Schema.Struct({ id: Schema.String, email: Schema.String, role: RelayTeamRole }),
  ),
  environments: Schema.Array(RelayTeamEnvironment),
  audit: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      action: Schema.String,
      actorUserId: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
  billing: Schema.NullOr(
    Schema.Struct({
      currentPeriodEnd: Schema.NullOr(Schema.Number),
      interval: Schema.NullOr(Schema.Literals(["month", "year"])),
      pendingSeats: Schema.NullOr(Schema.Number),
      state: Schema.String,
      checkoutEnabled: Schema.Boolean,
    }),
  ),
});
export type TeamDetail = typeof TeamDetail.Type;
const SeatPreview = Schema.Struct({
  id: Schema.String,
  amountDue: Schema.Number,
  currency: Schema.String,
  quantity: Schema.Number,
  effectiveAt: Schema.Number,
});
export type TeamSeatPreview = typeof SeatPreview.Type;
export class TeamsRequestError extends Error {}

export function createTeamsClient(options: {
  relayUrl: string;
  getToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}) {
  const origin = normalizeSecureRelayUrl(options.relayUrl);
  async function request(path: string, body?: unknown): Promise<unknown> {
    if (!origin) throw new TeamsRequestError("Teams is not configured for this installation.");
    const token = await options.getToken();
    if (!token) throw new TeamsRequestError("Sign in to manage your team.");
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`${origin}/v1/teams${path}`, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TeamsRequestError("Could not reach Teams. Check your connection and try again.");
    }
    if (!response.ok)
      throw new TeamsRequestError(
        response.status === 403
          ? "You no longer have permission for this team action. Refresh your team."
          : response.status === 409
            ? "This team changed while you were working. Refresh and try again."
            : "Could not complete the team action. Refresh and try again.",
      );
    return response.status === 204 ? null : response.json();
  }
  const path = (id: string, action = "") =>
    `/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
  async function redirect(id: string, action: "checkout" | "portal", body: unknown) {
    const result = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
      await request(path(id, action), body),
    );
    const url = new URL(result.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== (action === "checkout" ? "checkout.stripe.com" : "billing.stripe.com") ||
      url.port ||
      url.username ||
      url.password
    )
      throw new TeamsRequestError("Invalid billing destination.");
    return result.url;
  }
  return {
    list: async () =>
      Schema.decodeUnknownSync(
        Schema.Struct({ organizations: Schema.Array(RelayTeamOrganization) }),
      )(await request("")),
    detail: async (id: string) => Schema.decodeUnknownSync(TeamDetail)(await request(path(id))),
    create: (name: string) => request("", { name }),
    invite: (id: string, email: string, role: "admin" | "member") =>
      request(path(id, "invite"), { email, role }),
    revokeInvitation: (id: string, invitationId: string) =>
      request(path(id, "revoke-invite"), { invitationId }),
    role: (id: string, userId: string, role: "admin" | "member") =>
      request(path(id, "role"), { userId, role }),
    removeMember: (id: string, userId: string) => request(path(id, "remove-member"), { userId }),
    seat: (id: string, userId: string, assigned: boolean) =>
      request(path(id, "seat"), { userId, assigned }),
    policy: (id: string, policy: typeof RelayTeamPolicy.Type) =>
      request(path(id, "policy"), { policy }),
    checkout: (id: string, interval: "month" | "year", seats: number) =>
      redirect(id, "checkout", { interval, seats }),
    portal: (id: string) => redirect(id, "portal", {}),
    previewSeats: async (id: string, seats: number) =>
      Schema.decodeUnknownSync(SeatPreview)(await request(path(id, "seat-preview"), { seats })),
    confirmSeats: (id: string, previewId: string) =>
      request(path(id, "seat-confirm"), { previewId }),
  };
}

// Funding is an explicit choice for new links, never an authorization or an ownership transfer.
const selections = new Map<string, string>();
const listeners = new Set<() => void>();
export function selectedTeam(userId: string | null | undefined): string | null {
  return userId ? (selections.get(userId) ?? null) : null;
}
export function selectTeam(userId: string, organizationId: string | null): void {
  if (organizationId) selections.set(userId, organizationId);
  else selections.delete(userId);
  for (const listener of listeners) listener();
}
export function subscribeTeamSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
