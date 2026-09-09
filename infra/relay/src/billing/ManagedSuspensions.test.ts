import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BillingError } from "./BillingStore.ts";
import {
  cloudflareSuspensionProvider,
  runSuspensionJob,
  type SuspensionJob,
} from "./ManagedSuspensions.ts";

const job: SuspensionJob = {
  tunnel_id: "retired",
  user_id: "user",
  environment_id: "environment",
  account_generation: 4,
  reservation_generation: 7,
  stage: "rotating",
  attempts: 0,
};
it.effect(
  "cuts off old credentials before disconnecting active connectors, then deletes only that resource",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* runSuspensionJob(job, {
        enabled: () => Effect.succeed(true),
        checkpoint: (stage) =>
          Effect.sync(() => {
            calls.push(stage);
          }),
        finish: () =>
          Effect.sync(() => {
            calls.push("finish");
          }),
        provider: {
          rotate: (id) =>
            Effect.sync(() => {
              calls.push(`rotate:${id}`);
            }),
          disconnect: (id) =>
            Effect.sync(() => {
              calls.push(`disconnect:${id}`);
            }),
          remove: (id) =>
            Effect.sync(() => {
              calls.push(`delete:${id}`);
            }),
        },
      });
      expect(calls).toEqual([
        "rotate:retired",
        "rotated",
        "disconnect:retired",
        "disconnected",
        "delete:retired",
        "deleted",
        "finish",
      ]);
    }),
);
it.effect(
  "rollback between stages halts destructive work; a later run resumes the saved boundary",
  () =>
    Effect.gen(function* () {
      let enabled = true;
      let stage = job.stage;
      const calls: string[] = [];
      const hooks = {
        enabled: () => Effect.sync(() => enabled),
        checkpoint: (next: string) =>
          Effect.sync(() => {
            stage = next;
            enabled = false;
          }),
        finish: () =>
          Effect.sync(() => {
            calls.push("finish");
          }),
        provider: {
          rotate: () =>
            Effect.sync(() => {
              calls.push("rotate");
            }),
          disconnect: () =>
            Effect.sync(() => {
              calls.push("disconnect");
            }),
          remove: () =>
            Effect.sync(() => {
              calls.push("delete");
            }),
        },
      };
      yield* runSuspensionJob(job, hooks);
      expect(calls).toEqual(["rotate"]);
      expect(stage).toBe("rotated");
      enabled = true;
      yield* runSuspensionJob(
        { ...job, stage },
        {
          ...hooks,
          checkpoint: (next) =>
            Effect.sync(() => {
              stage = next;
            }),
        },
      );
      expect(calls).toEqual(["rotate", "disconnect", "delete", "finish"]);
    }),
);
it.effect(
  "failed disconnect remains retryable without prematurely deleting or releasing quota",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* runSuspensionJob(
        { ...job, stage: "rotated" },
        {
          enabled: () => Effect.succeed(true),
          checkpoint: () =>
            Effect.sync(() => {
              calls.push("checkpoint");
            }),
          finish: () =>
            Effect.sync(() => {
              calls.push("finish");
            }),
          provider: {
            rotate: () =>
              Effect.sync(() => {
                calls.push("rotate");
              }),
            disconnect: () =>
              Effect.fail(new BillingError({ code: "unavailable", message: "offline" })),
            remove: () =>
              Effect.sync(() => {
                calls.push("delete");
              }),
          },
        },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(calls).toEqual([]);
    }),
);
it.effect(
  "the Cloudflare adapter uses token rotation and force-disconnect endpoints, tolerating deleted resources",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; method: string | undefined; body: string | undefined }> =
        [];
      const provider = cloudflareSuspensionProvider({
        accountId: "account",
        apiToken: "not-a-real-secret",
        fetch: async (input, init) => {
          calls.push({
            url: String(input),
            method: init?.method,
            body: typeof init?.body === "string" ? init.body : undefined,
          });
          return new Response('{"success":true}', { status: calls.length === 3 ? 404 : 200 });
        },
      });
      yield* provider.rotate("old-id");
      yield* provider.disconnect("old-id");
      yield* provider.remove("old-id");
      expect(calls.map(({ url, method }) => [url, method])).toEqual([
        ["https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/old-id", "PATCH"],
        [
          "https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/old-id/connections",
          "DELETE",
        ],
        ["https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/old-id", "DELETE"],
      ]);
      expect(calls[0]?.body).toMatch(/"tunnel_secret":"[A-Za-z0-9+/]{43}="/);
    }),
);

it.effect(
  "a persisted rotated stage resumes after restart without ever targeting a replacement",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let finished = false;
      const hooks = {
        enabled: () => Effect.succeed(true),
        checkpoint: () => Effect.void,
        finish: () =>
          Effect.sync(() => {
            finished = true;
          }),
        provider: {
          rotate: (id: string) =>
            Effect.sync(() => {
              calls.push(`rotate:${id}`);
            }),
          disconnect: (id: string) =>
            Effect.sync(() => {
              calls.push(`disconnect:${id}`);
            }),
          remove: (id: string) =>
            Effect.sync(() => {
              calls.push(`delete:${id}`);
            }),
        },
      };
      yield* runSuspensionJob({ ...job, stage: "rotated" }, hooks);
      expect(calls).toEqual(["disconnect:retired", "delete:retired"]);
      expect(finished).toBe(true);
      calls.length = 0;
      finished = false;
      yield* runSuspensionJob(job, { ...hooks, enabled: () => Effect.succeed(false) });
      expect(calls).toEqual([]);
      expect(finished).toBe(false);
    }),
);
