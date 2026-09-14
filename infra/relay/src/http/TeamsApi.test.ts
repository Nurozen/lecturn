import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TeamError, type TeamAccount, TeamStore } from "../teams/TeamStore.ts";
import { TeamDirectory } from "../teams/TeamDirectory.ts";
import { TeamBillingService } from "../teams/TeamBillingService.ts";
import { teamsRoutes, TeamGatewaySync } from "./TeamsApi.ts";
import { RelayConfiguration } from "../Config.ts";
vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const account: TeamAccount = {
  organization_id: "org_team",
  owner_user_id: "owner",
  customer_id: "cus_team",
  subscription_id: "sub_team",
  purchased_seats: 5,
  access_until: 1000,
  access_window_start: 0,
  interval: "month",
  current_period_end: 1000,
  pending_seats: null,
  policy: { allowedProviders: null, publishAgentActivity: true },
  generation: 0,
  billing_lease_owner: null,
  billing_state: {},
  status: "active",
  suspended: false,
  reconcile_after: 0,
  billing_lease_expires_at: 0,
  created_at: 0,
  updated_at: 0,
};
function fixture() {
  const events: string[] = [];
  const memberships = new Map<string, string>([
    ["owner", "org:admin"],
    ["admin", "org:admin"],
    ["employee", "org:member"],
  ]);
  type Membership = NonNullable<Effect.Success<ReturnType<TeamDirectory["Service"]["membership"]>>>;
  const member = (userId: string): Membership | null =>
    memberships.has(userId)
      ? ({
          role: memberships.get(userId),
          organization: { id: "org_team", name: "Example Team" },
          publicUserData: {
            userId,
            identifier: `${userId}@example.test`,
            firstName: userId,
            lastName: "",
          },
        } as Membership)
      : null;
  const directory = {
    membership: vi.fn((org: string, user: string) =>
      Effect.succeed(org === "org_team" ? member(user) : null),
    ),
    organizations: vi.fn((user: string) => Effect.succeed(member(user) ? [member(user)!] : [])),
    members: vi.fn(() => Effect.succeed([...memberships.keys()].map((user) => member(user)!))),
    invitations: vi.fn(() => Effect.succeed([])),
    invite: vi.fn(() => Effect.succeed({ id: "invite" })),
    revokeInvitation: vi.fn(() => Effect.void),
    setRole: vi.fn(() => Effect.void),
    removeMember: vi.fn(() =>
      Effect.sync(() => {
        events.push("directory.remove");
      }),
    ),
    create: vi.fn(() => Effect.succeed({ id: "org_team" })),
  };
  const store = {
    markUserDeleted: vi.fn((_userId: string) =>
      Effect.succeed({
        ownedOrganizationIds: ["org_team"],
        affectedUserIds: ["owner", "employee"],
      }),
    ),
    get: vi.fn((org: string) => Effect.succeed(org === "org_team" ? account : null)),
    seats: vi.fn(() =>
      Effect.succeed([{ organization_id: "org_team", user_id: "employee", assigned_at: 0 }]),
    ),
    audit: vi.fn(() => Effect.void),
    bootstrap: vi.fn(() => Effect.succeed(account)),
    inventory: vi.fn(() =>
      Effect.succeed([
        { user_id: "employee", environment_id: "env", name: "device", status: "linked" as const },
      ]),
    ),
    history: vi.fn(() => Effect.succeed([])),
    assignSeat: vi.fn(() => Effect.succeed(undefined)),
    revokeSeat: vi.fn(() =>
      Effect.sync(() => {
        events.push("seat.revoke");
        return ["env"];
      }),
    ),
    updatePolicy: vi.fn(() => Effect.void),
    funding: vi.fn(() => Effect.succeed(undefined)),
    access: vi.fn(() => Effect.succeed(undefined)),
    bindEnvironment: vi.fn(() => Effect.succeed(undefined)),
    unbindEnvironment: vi.fn(() => Effect.succeed(undefined)),
  } satisfies TeamStore["Service"];
  return {
    store,
    directory,
    memberships,
    events,
    directoryService: directory as unknown as TeamDirectory["Service"],
  };
}
const settings: RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.test",
  apns: {
    teamId: "test",
    keyId: "test",
    privateKey: Redacted.make("test"),
    bundleId: "test",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("test"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "relay",
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  cloudMintPrivateKey: Redacted.make("test"),
  cloudMintPublicKey: "test",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const webhookKey = Buffer.from("test-clerk-webhook-key").toString("base64");
const routeConfig = {
  appOrigin: "https://app.test",
  clerkWebhookSecret: `whsec_${webhookKey}`,
  checkoutEnabled: true,
};
const billingResult = {
  purchasedSeats: 5,
  pendingSeats: null,
  accessUntil: 1000,
  status: "active",
  interval: "month" as const,
};
const makeBilling = () =>
  ({
    checkout: vi.fn(() => Effect.succeed({ url: "https://checkout.stripe.com/test" })),
    portal: vi.fn(() => Effect.succeed({ url: "https://billing.stripe.com/test" })),
    preview: vi.fn(() =>
      Effect.succeed({
        id: "preview",
        amountDue: 100,
        currency: "usd",
        quantity: 6,
        effectiveAt: 0,
      }),
    ),
    confirm: vi.fn(() => Effect.succeed(billingResult)),
    reconcile: vi.fn(() => Effect.succeed(billingResult)),
    closeOrganization: vi.fn(
      (_organizationId: string): Effect.Effect<void, TeamError> => Effect.void,
    ),
    processPending: vi.fn(() => Effect.void),
    receiveWebhook: vi.fn(() => Effect.void),
  }) satisfies TeamBillingService["Service"];
const auth = (userId: string) => {
  vi.mocked(verifyToken).mockResolvedValue({ sub: userId, aud: "relay" } as never);
  vi.mocked(createClerkClient).mockReturnValue({
    users: {
      getUser: vi.fn().mockResolvedValue({
        banned: false,
        locked: false,
        emailAddresses: [{ verification: { status: "verified" } }],
      }),
    },
  } as never);
};
const post = (path: string, payload: unknown, origin = routeConfig.appOrigin) =>
  new Request(`https://relay.test/v1/teams/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer signed-session", "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
function run(
  request: Request,
  f = fixture(),
  billing = makeBilling(),
  sync: TeamGatewaySync["Service"]["sync"] = vi.fn(() => Effect.void),
) {
  return Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(
      teamsRoutes(routeConfig).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(EnvironmentCredentials, {
              create: () => Effect.succeed("credential"),
              authenticate: () => Effect.succeed(Option.none()),
              revokeForEnvironmentPublicKey: () => Effect.succeed(false),
            }),
            Layer.succeed(EnvironmentLinks, {
              upsert: () => Effect.void,
              listUsersForEnvironment: () => Effect.succeed([]),
              listDeliveryUsersForEnvironment: () => Effect.succeed([]),
              listPublicKeysForEnvironment: () => Effect.succeed([]),
              listForUser: () => Effect.succeed([]),
              getForUser: () => Effect.succeed(null),
              revokeForUser: () => Effect.succeed(false),
            }),
            Layer.succeed(TeamStore, f.store),
            Layer.succeed(TeamDirectory, f.directoryService),
            Layer.succeed(TeamBillingService, billing),
            Layer.succeed(TeamGatewaySync, { sync }),
            Layer.succeed(RelayConfiguration, settings),
          ),
        ),
      ),
    );
    return HttpServerResponse.toWeb(
      yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      ),
    );
  });
}
const webhookTimestamp = Math.floor(vi.getRealSystemTime() / 1000);
function clerkWebhook(payload: unknown, valid = true) {
  const body = JSON.stringify(payload);
  const id = "msg_test";
  const signature = NodeCrypto.createHmac("sha256", Buffer.from(webhookKey, "base64"))
    .update(`${id}.${webhookTimestamp}.${body}`)
    .digest("base64");
  return new Request("https://relay.test/v1/teams/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(webhookTimestamp),
      "svix-signature": `v1,${valid ? signature : "invalid"}`,
    },
    body,
  });
}
describe("Teams HTTP authorization boundary", () => {
  it.effect("requires verified identity and rejects unsigned user hints", () =>
    Effect.gen(function* () {
      const f = fixture();
      const response = yield* run(
        new Request("https://relay.test/v1/teams?userId=owner", {
          headers: { "x-user-id": "owner" },
        }),
        f,
      );
      expect(response.status).toBe(401);
      expect(f.directory.organizations).not.toHaveBeenCalled();
    }),
  );
  it.effect("uses token subject, not a payload user hint, for company creation", () =>
    Effect.gen(function* () {
      auth("owner");
      const f = fixture();
      const response = yield* run(post("", { name: "Example", userId: "outsider" }), f);
      expect(response.status).toBe(201);
      expect(f.directory.create).toHaveBeenCalledWith({ name: "Example", userId: "owner" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }),
  );
  it.effect("does not accept JWTs for another audience as organization identity", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "owner", aud: "other-app" } as never);
      vi.mocked(createClerkClient).mockReturnValue({
        oauthAccessTokens: { verify: vi.fn().mockRejectedValue(new Error("invalid")) },
      } as never);
      const f = fixture();
      const response = yield* run(
        post("org_team/invite", { email: "new@example.test", role: "member" }),
        f,
      );
      expect(response.status).toBe(403);
      expect(f.directory.invite).not.toHaveBeenCalled();
    }),
  );
  it.effect("blocks cross-origin mutations and invalid seat quantities before Stripe", () =>
    Effect.gen(function* () {
      auth("owner");
      const f = fixture();
      const billing = makeBilling();
      expect(
        (yield* run(
          post("org_team/checkout", { interval: "month", seats: 5 }, "https://attacker.test"),
          f,
          billing,
        )).status,
      ).toBe(403);
      for (const seats of [0, 4, 5.5, 10001])
        expect(
          (yield* run(post("org_team/checkout", { interval: "month", seats }), f, billing)).status,
        ).toBeGreaterThanOrEqual(400);
      expect(billing.checkout).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "prevents ordinary members from buying seats and outsiders from forcing gateway sync",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const billing = makeBilling();
        const sync = vi.fn(() => Effect.void);
        auth("employee");
        expect(
          (yield* run(post("org_team/checkout", { interval: "month", seats: 5 }), f, billing, sync))
            .status,
        ).toBe(403);
        auth("outsider");
        expect(
          (yield* run(post("org_team/remove-member", { userId: "employee" }), f, billing, sync))
            .status,
        ).toBe(403);
        expect(billing.checkout).not.toHaveBeenCalled();
        expect(sync).not.toHaveBeenCalled();
        expect(f.store.revokeSeat).not.toHaveBeenCalled();
      }),
  );
  it.effect(
    "user deletion tombstones all access and synchronizes coworkers before billing cleanup, including retries",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const events: string[] = [];
        f.store.markUserDeleted.mockImplementation(() =>
          Effect.sync(() => {
            events.push("tombstone");
            return { ownedOrganizationIds: ["org_team"], affectedUserIds: ["owner", "employee"] };
          }),
        );
        const billing = makeBilling();
        billing.closeOrganization.mockImplementation(() =>
          Effect.suspend(() => {
            events.push("cancel");
            return Effect.fail(
              new TeamError({ code: "unavailable", message: "Stripe temporarily unavailable" }),
            );
          }),
        );
        const sync = vi.fn((user: string) =>
          Effect.sync(() => {
            events.push(`sync:${user}`);
          }),
        );
        const event = { type: "user.deleted", data: { id: "owner", deleted: true } };
        expect((yield* run(clerkWebhook(event, false), f, billing, sync)).status).toBe(403);
        expect(events).toEqual([]);
        expect((yield* run(clerkWebhook(event), f, billing, sync)).status).toBe(503);
        expect(events).toEqual(["tombstone", "sync:owner", "sync:employee", "cancel"]);
        expect(f.store.markUserDeleted).toHaveBeenCalledWith("owner");
        billing.closeOrganization.mockImplementation(() => Effect.void);
        expect((yield* run(clerkWebhook(event), f, billing, sync)).status).toBe(200);
        expect(billing.closeOrganization).toHaveBeenCalledWith("org_team");
      }),
  );
  it.effect("deleting a non-owner still revokes their seats without closing another company", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.store.markUserDeleted.mockReturnValue(
        Effect.succeed({ ownedOrganizationIds: [], affectedUserIds: ["employee"] }),
      );
      const billing = makeBilling();
      const sync = vi.fn(() => Effect.void);
      expect(
        (yield* run(
          clerkWebhook({ type: "user.deleted", data: { id: "employee", deleted: true } }),
          f,
          billing,
          sync,
        )).status,
      ).toBe(200);
      expect(f.store.markUserDeleted).toHaveBeenCalledWith("employee");
      expect(sync).toHaveBeenCalledWith("employee");
      expect(billing.closeOrganization).not.toHaveBeenCalled();
    }),
  );
  it.effect("requires authentic Clerk webhook signatures before offboarding", () =>
    Effect.gen(function* () {
      const f = fixture();
      const sync = vi.fn(() => Effect.void);
      const event = {
        type: "organizationMembership.deleted",
        data: { organization: { id: "org_team" }, public_user_data: { user_id: "employee" } },
      };
      expect((yield* run(clerkWebhook(event, false), f, makeBilling(), sync)).status).toBe(403);
      expect(f.store.revokeSeat).not.toHaveBeenCalled();
      expect((yield* run(clerkWebhook(event), f, makeBilling(), sync)).status).toBe(200);
      expect(f.store.revokeSeat).toHaveBeenCalledWith({
        organizationId: "org_team",
        actorUserId: "clerk-webhook",
        userId: "employee",
      });
      expect(sync).toHaveBeenCalledWith("employee");
    }),
  );
});

it.effect("requires verified email before creating a purchasing organization", () =>
  Effect.gen(function* () {
    auth("owner");
    vi.mocked(createClerkClient).mockReturnValue({
      users: {
        getUser: vi.fn().mockResolvedValue({ banned: false, locked: false, emailAddresses: [] }),
      },
    } as never);
    const f = fixture();
    expect((yield* run(post("", { name: "Company" }), f)).status).toBe(403);
    expect(f.directory.create).not.toHaveBeenCalled();
  }),
);

it.effect("does not substitute a user session for an environment policy credential", () =>
  Effect.gen(function* () {
    auth("owner");
    const f = fixture();
    const response = yield* run(
      new Request("https://relay.test/v1/teams/environment-policy?environmentId=other", {
        headers: { authorization: "Bearer signed-session" },
      }),
      f,
    );
    expect(response.status).toBe(401);
    expect(f.store.access).not.toHaveBeenCalled();
  }),
);
