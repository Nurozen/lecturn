#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Standalone Node protocol probe uses native HTTP, time and a local credential file.
/** Sends authenticated registrations through a deployed development relay's Hyperdrive. */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted, Schema } from "effect";

class ProbeFailed extends Schema.TaggedErrorClass<ProbeFailed>()("ProbeFailed", {
  message: Schema.String,
}) {}

const Input = Schema.Struct({
  stage: Schema.String,
  relayUrl: Schema.String,
  accounts: Schema.Tuple([
    Schema.Struct({ userId: Schema.String, clerkToken: Schema.String }),
    Schema.Struct({ userId: Schema.String, clerkToken: Schema.String }),
  ]),
});
const Token = Schema.Struct({ access_token: Schema.String });
const decodeToken = Schema.decodeUnknownSync(Token);
const decodeSubject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Input));
const timeout = () => AbortSignal.timeout(15_000);

async function main() {
  const input = decode(await NodeFSP.readFile(process.argv[2] ?? "", "utf8"));
  if (!input.stage || input.stage === "prod" || !process.env.RELAY_PUSH_TEST_DATABASE_URL)
    throw new Error("A development stage and RELAY_PUSH_TEST_DATABASE_URL are required");
  if (input.accounts[0].userId === input.accounts[1].userId)
    throw new Error("Two distinct development accounts are required");
  for (const account of input.accounts) {
    const subject = decodeSubject(
      Buffer.from(account.clerkToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).sub;
    if (subject !== account.userId)
      throw new Error("Development account userId does not match its Clerk token subject");
  }
  const relay = new URL(input.relayUrl);
  if (!relay.hostname.startsWith("relay-"))
    throw new Error("Use a development relay-<stage> domain");
  const origin = relay.origin;
  if (origin === "https://relay.lecturn.cloudgatherer.net")
    throw new Error("Production relay is prohibited");
  const key = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = key.publicKey.export({ format: "jwk" });
  const proof = (method: string, url: string, accessToken?: string) => {
    const header = Buffer.from(encode({ alg: "ES256", typ: "dpop+jwt", jwk })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      encode({
        jti: NodeCrypto.randomUUID(),
        htm: method,
        htu: url,
        iat: Math.floor(Date.now() / 1000),
        ...(accessToken
          ? { ath: NodeCrypto.createHash("sha256").update(accessToken).digest("base64url") }
          : {}),
      }),
    ).toString("base64url");
    return `${header}.${payload}.${NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const tokens = await Promise.all(
    input.accounts.map(async (account) => {
      const url = `${origin}/v1/client/dpop-token`;
      const response = await fetch(url, {
        method: "POST",
        signal: timeout(),
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof("POST", url) },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: account.clerkToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource: origin,
          scope: "mobile:registration",
          client_id: "lecturn-mobile",
        }),
      });
      if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
      return decodeToken(await response.json()).access_token;
    }),
  );
  const request = async (
    index: number,
    path: string,
    body: unknown,
    method: "POST" | "DELETE" = "POST",
  ) => {
    const url = `${origin}${path}`;
    const response = await fetch(url, {
      method,
      signal: timeout(),
      headers: {
        authorization: `DPoP ${tokens[index]!}`,
        dpop: proof(method, url, tokens[index]),
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: encode(body) } : {}),
    });
    if (!response.ok) throw new Error(`Registration failed (${response.status})`);
  };
  const prefix = `multi-account-probe-${NodeCrypto.randomUUID()}`;
  const accountIds = input.accounts.map((account) => account.userId);
  const preferences = {
    notificationsEnabled: false,
    notifyOnApproval: false,
    notifyOnInput: false,
    notifyOnCompletion: false,
    notifyOnFailure: false,
    liveActivitiesEnabled: false,
  };
  const register = (index: number, device: string, list?: readonly string[]) =>
    request(index, "/v1/mobile/devices", {
      deviceId: `${prefix}-${device}`,
      label: "Multi-account development probe",
      platform: "ios",
      iosMajorVersion: 18,
      pushToken: `${prefix}-push`,
      pushToStartToken: `${prefix}-start`,
      preferences,
      ...(list ? { deviceAccountIds: list } : {}),
    });
  const activity = (index: number, device: string, list?: readonly string[]) =>
    request(index, "/v1/mobile/live-activities", {
      deviceId: `${prefix}-${device}`,
      activityPushToken: `${prefix}-activity`,
      ...(list ? { deviceAccountIds: list } : {}),
    });
  const program = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`SELECT kind FROM relay_push_token_owners LIMIT 0`;
    const verify = Effect.fn("verifyMultiAccountPush")(function* (count: number, live = false) {
      const rows = live
        ? yield* sql<{
            user_id: string;
            device_id: string;
          }>`SELECT user_id, device_id FROM relay_live_activities WHERE activity_push_token=${`${prefix}-activity`}`
        : yield* sql<{
            user_id: string;
            device_id: string;
          }>`SELECT user_id, device_id FROM relay_mobile_devices WHERE push_token=${`${prefix}-push`} AND push_to_start_token=${`${prefix}-start`}`;
      if (rows.length !== count)
        return yield* Effect.fail(
          new ProbeFailed({
            message: `Expected ${count} retained registrations, got ${rows.length}`,
          }),
        );
      if (count === 1) {
        const owners = yield* sql<{
          device_id: string;
        }>`SELECT device_id FROM relay_push_token_owners WHERE kind=${live ? "activity" : "push"} AND token=${`${prefix}-${live ? "activity" : "push"}`}`;
        if (owners[0]?.device_id !== rows[0]?.device_id)
          return yield* Effect.fail(
            new ProbeFailed({ message: "Token owner and recipient diverged" }),
          );
      }
    });
    yield* Effect.tryPromise(() =>
      Promise.all([register(0, "phone", accountIds), register(1, "tablet", accountIds)]),
    );
    yield* verify(1);
    yield* Effect.tryPromise(() => register(0, "phone", accountIds));
    yield* Effect.tryPromise(() => register(1, "phone", accountIds));
    yield* verify(2);
    yield* Effect.tryPromise(() => register(1, "phone", [accountIds[1]!]));
    yield* verify(1);
    yield* Effect.tryPromise(() => register(0, "phone"));
    yield* verify(1);
    yield* Effect.tryPromise(() =>
      Promise.all([activity(0, "phone", accountIds), activity(1, "tablet", accountIds)]),
    );
    yield* verify(1, true);
    yield* Effect.tryPromise(() => activity(0, "phone", accountIds));
    yield* Effect.tryPromise(() => activity(1, "phone", accountIds));
    yield* verify(2, true);
    yield* Effect.tryPromise(() => activity(1, "phone", [accountIds[1]!]));
    yield* verify(1, true);
    yield* Effect.tryPromise(() => activity(0, "phone"));
    yield* verify(1, true);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const account of input.accounts) {
          yield* sql`DELETE FROM relay_live_activities WHERE user_id=${account.userId} AND device_id IN (${`${prefix}-phone`},${`${prefix}-tablet`})`;
          yield* sql`DELETE FROM relay_mobile_devices WHERE user_id=${account.userId} AND device_id IN (${`${prefix}-phone`},${`${prefix}-tablet`})`;
        }
        yield* sql`DELETE FROM relay_push_token_owners WHERE token IN (${`${prefix}-push`},${`${prefix}-start`},${`${prefix}-activity`})`;
      }).pipe(Effect.orDie),
    ),
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(process.env.RELAY_PUSH_TEST_DATABASE_URL!),
        connectTimeout: "10 seconds",
      }),
    ),
  );
  try {
    await Effect.runPromise(program);
  } finally {
    // The authenticated path can remove fixture registrations even if the
    // direct verification connection was unavailable or pointed at the wrong stage.
    await Promise.allSettled(
      input.accounts.flatMap((_account, index) =>
        ["phone", "tablet"].map((device) =>
          request(index, `/v1/mobile/devices/${prefix}-${device}`, undefined, "DELETE"),
        ),
      ),
    );
  }
  process.stdout.write(
    "Development Hyperdrive concurrency, retention, legacy claims, and cleanup passed.\n",
  );
}
await main();
