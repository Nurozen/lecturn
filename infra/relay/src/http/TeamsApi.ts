import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as FileSystem from "effect/FileSystem";
import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { RelayTeamPolicy } from "@lecturn/contracts";
import { RelayConfiguration } from "../Config.ts";
import { verifyRelayClientBearerToken } from "./Api.ts";
import { TeamStore, TeamError } from "../teams/TeamStore.ts";
import { TeamDirectory } from "../teams/TeamDirectory.ts";
import { TeamBillingService } from "../teams/TeamBillingService.ts";
import { makeTeamAdmin } from "../teams/TeamAdmin.ts";
import { isBillingAppOrigin } from "../billing/BillingConfig.ts";

export interface TeamsRouteConfig {
  appOrigin: string;
  additionalAppOrigins?: readonly string[];
  clerkWebhookSecret: string;
  checkoutEnabled: boolean;
}
export class TeamGatewaySync extends Context.Service<
  TeamGatewaySync,
  { readonly sync: (userId: string) => Effect.Effect<void, TeamError> }
>()("lecturn-relay/http/TeamsApi/TeamGatewaySync") {}
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const role = Schema.Literals(["admin", "member"]);
const seats = Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 10000 }));
const invalid = () => new TeamError({ code: "conflict", message: "Invalid team request." });
export function teamsRoutes(routeConfig: TeamsRouteConfig) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* TeamStore;
      const directory = yield* TeamDirectory;
      const billing = yield* TeamBillingService;
      const gateway = yield* TeamGatewaySync;
      const config = yield* RelayConfiguration;
      const credentials = yield* EnvironmentCredentials;
      const links = yield* EnvironmentLinks;
      const requireVerifiedIdentity = Effect.fn("Teams.requireVerifiedIdentity")(function* (
        userId: string,
      ) {
        const user = yield* Effect.tryPromise({
          try: () =>
            createClerkClient({ secretKey: Redacted.value(config.clerkSecretKey) }).users.getUser(
              userId,
            ),
          catch: () =>
            new TeamError({ code: "unavailable", message: "Account verification unavailable" }),
        });
        if (
          user.banned ||
          user.locked ||
          !user.emailAddresses.some((email) => email.verification?.status === "verified")
        )
          return yield* new TeamError({
            code: "forbidden",
            message: "Verify your email before creating or purchasing for a team.",
          });
      });
      const admin = makeTeamAdmin(store, directory, gateway.sync);
      const syncOrganization = Effect.fn("Teams.syncOrganization")(function* (
        organizationId: string,
      ) {
        const users = new Set((yield* store.inventory(organizationId)).map((env) => env.user_id));
        yield* Effect.forEach(users, (userId) => gateway.sync(userId), {
          concurrency: 4,
          discard: true,
        });
      });
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, routeConfig.appOrigin).pathname;
        if (path === "/v1/teams/environment-policy" && request.method === "GET") {
          const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
          if (!token) return json({ message: "Environment authentication required" }, 401);
          const principal = yield* credentials.authenticate(token).pipe(
            Effect.mapError(
              () =>
                new TeamError({
                  code: "unavailable",
                  message: "Environment authentication unavailable",
                }),
            ),
          );
          if (Option.isNone(principal))
            return json({ message: "Invalid environment credential" }, 401);
          const owners = yield* links
            .listUsersForEnvironment({
              environmentId: principal.value.environmentId,
              environmentPublicKey: principal.value.environmentPublicKey,
              includeAllLinkedUsers: true,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new TeamError({ code: "unavailable", message: "Environment lookup unavailable" }),
              ),
            );
          const policies = [];
          for (const owner of owners) {
            const link = yield* links
              .getForUser({ userId: owner, environmentId: principal.value.environmentId })
              .pipe(
                Effect.mapError(
                  () =>
                    new TeamError({
                      code: "unavailable",
                      message: "Environment lookup unavailable",
                    }),
                ),
              );
            if (link?.environmentPublicKey !== principal.value.environmentPublicKey) continue;
            const access = yield* store.access(
              owner,
              principal.value.environmentId,
              Math.floor((yield* Clock.currentTimeMillis) / 1000),
            );
            if (access) policies.push(access);
          }
          if (policies.length > 1)
            return json(
              { message: "Environment funding is ambiguous. Unlink and publish again." },
              409,
            );
          const policy = policies[0];
          return json(
            policy
              ? {
                  organizationId: policy.organizationId,
                  hasAccess: policy.allowed,
                  ...policy.policy,
                }
              : null,
          );
        }
        if (path === "/v1/teams/webhooks/stripe" && request.method === "POST") {
          const signature = request.headers["stripe-signature"];
          if (!signature) return json({ message: "Missing signature" }, 400);
          yield* billing.receiveWebhook(
            new Uint8Array(yield* request.arrayBuffer.pipe(Effect.mapError(invalid))),
            signature,
          );
          return json({ received: true });
        }
        if (path === "/v1/teams/webhooks/clerk" && request.method === "POST") {
          const webRequest = yield* HttpServerRequest.toWeb(request);
          const event = yield* Effect.tryPromise({
            try: () => verifyWebhook(webRequest, { signingSecret: routeConfig.clerkWebhookSecret }),
            catch: () => new TeamError({ code: "forbidden", message: "Invalid webhook signature" }),
          });
          if (event.type === "organizationMembership.deleted") {
            const org = event.data.organization.id;
            const userId = event.data.public_user_data.user_id;
            if (yield* store.get(org)) {
              yield* store.revokeSeat({
                organizationId: org,
                actorUserId: "clerk-webhook",
                userId,
              });
              yield* gateway.sync(userId);
            }
          } else if (event.type === "organization.deleted" && event.data.id) {
            const organizationId = event.data.id;
            if (yield* store.get(organizationId)) yield* billing.closeOrganization(organizationId);
            for (const seat of yield* store.seats(organizationId)) {
              yield* store.revokeSeat({
                organizationId,
                actorUserId: "clerk-webhook",
                userId: seat.user_id,
              });
              yield* gateway.sync(seat.user_id);
            }
          } else if (event.type === "user.deleted" && event.data.id) {
            const deleted = yield* store.markUserDeleted(event.data.id);
            // End transport access before Stripe calls, which may need webhook retries.
            yield* Effect.forEach(deleted.affectedUserIds, (userId) => gateway.sync(userId), {
              concurrency: 4,
              discard: true,
            });
            for (const organizationId of deleted.ownedOrganizationIds)
              yield* billing.closeOrganization(organizationId);
          }
          return json({ received: true });
        }
        const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
        if (!bearer) return json({ message: "Sign in to manage Teams" }, 401);
        const verified = yield* verifyRelayClientBearerToken(config, bearer).pipe(
          Effect.mapError(
            () => new TeamError({ code: "forbidden", message: "Sign in to manage Teams" }),
          ),
        );
        const userId = verified.sub;
        const segments = path.slice("/v1/teams".length).split("/").filter(Boolean);
        const organizationId = segments[0];
        if (request.method === "GET") {
          if (!organizationId) return json(yield* admin.list(userId));
          if (segments.length !== 1) return json({ message: "Not found" }, 404);
          return json(yield* admin.detail(organizationId, userId, routeConfig.checkoutEnabled));
        }
        if (request.method !== "POST") return json({ message: "Not found" }, 404);
        if (
          request.headers.origin &&
          !isBillingAppOrigin(
            request.headers.origin,
            routeConfig.appOrigin,
            routeConfig.additionalAppOrigins,
          )
        )
          return json({ message: "Manage Teams from your Lecturn account" }, 403);
        if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
          return json({ message: "JSON required" }, 400);
        const payload = yield* request.json.pipe(Effect.mapError(invalid));
        const decode = <S extends Schema.Top>(schema: S) =>
          Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.mapError(invalid));
        if (!organizationId) {
          const { name } = yield* decode(Schema.Struct({ name: text }));
          yield* requireVerifiedIdentity(userId);
          return json(yield* admin.create(userId, name), 201);
        }
        const action = segments[1];
        if (segments.length !== 2) return json({ message: "Not found" }, 404);
        switch (action) {
          case "invite": {
            const p = yield* decode(
              Schema.Struct({
                email: Schema.String.check(
                  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
                  Schema.isMaxLength(254),
                ),
                role,
              }),
            );
            yield* admin.invite(organizationId, userId, p.email, p.role);
            break;
          }
          case "revoke-invite": {
            const p = yield* decode(Schema.Struct({ invitationId: text }));
            yield* admin.revokeInvitation(organizationId, userId, p.invitationId);
            break;
          }
          case "role": {
            const p = yield* decode(Schema.Struct({ userId: text, role }));
            yield* admin.setRole(organizationId, userId, p.userId, p.role);
            break;
          }
          case "remove-member": {
            const p = yield* decode(Schema.Struct({ userId: text }));
            yield* admin.removeMember(organizationId, userId, p.userId);
            break;
          }
          case "seat": {
            const p = yield* decode(Schema.Struct({ userId: text, assigned: Schema.Boolean }));
            yield* admin.seat(organizationId, userId, p.userId, p.assigned);
            yield* gateway.sync(p.userId);
            break;
          }
          case "policy": {
            const p = yield* decode(Schema.Struct({ policy: RelayTeamPolicy }));
            yield* admin.policy(organizationId, userId, p.policy);
            yield* syncOrganization(organizationId);
            break;
          }
          case "checkout": {
            if (!routeConfig.checkoutEnabled)
              return json({ message: "Teams checkout is not available" }, 503);
            yield* admin.authorize(organizationId, userId, "owner");
            const p = yield* decode(
              Schema.Struct({ interval: Schema.Literals(["month", "year"]), seats }),
            );
            yield* requireVerifiedIdentity(userId);
            return json(yield* billing.checkout(organizationId, userId, p.interval, p.seats));
          }
          case "portal":
            yield* admin.authorize(organizationId, userId, "owner");
            return json(yield* billing.portal(organizationId, userId));
          case "seat-preview": {
            yield* admin.authorize(organizationId, userId, "owner");
            const p = yield* decode(Schema.Struct({ seats }));
            return json(yield* billing.preview(organizationId, userId, p.seats));
          }
          case "seat-confirm": {
            yield* admin.authorize(organizationId, userId, "owner");
            const p = yield* decode(Schema.Struct({ previewId: text }));
            const result = yield* billing.confirm(organizationId, userId, p.previewId);
            yield* syncOrganization(organizationId);
            return json(result);
          }
          default:
            return json({ message: "Not found" }, 404);
        }
        return json({ ok: true });
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(512 * 1024)),
        Effect.catchTag("TeamError", (error) =>
          Effect.succeed(
            json(
              { code: error.code, message: error.message },
              error.code === "forbidden"
                ? 403
                : error.code === "not_found"
                  ? 404
                  : error.code === "unavailable"
                    ? 503
                    : 409,
            ),
          ),
        ),
      );
      return Layer.mergeAll(
        HttpRouter.add("GET", "/v1/teams/*", handler),
        HttpRouter.add("POST", "/v1/teams/*", handler),
      );
    }),
  );
}
