import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as SessionStore from "../auth/SessionStore.ts";
import { DeviceToolkit } from "../mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";
import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import { RESERVED_APP_TOOL_PREFIXES } from "./AppRegistryService.ts";
import { AppLeaseService, AppRegistryService } from "./services.ts";
import {
  appProject,
  errorCode,
  liveDefinitions,
  makeRegistration,
  makeRegistryLayer as makeLayer,
  registration,
  sidecar,
  streamQueue,
} from "./testing/appRegistryTestLayer.ts";

const headlessDefinitions = [
  new McpSchema.Tool({ name: "design", inputSchema: { type: "object" } }),
];
const liveLease = { url: "http://127.0.0.1:4100/mcp", bearer: "live-bearer", ttlSeconds: 20 };

type Registry = AppRegistryService["Service"];

const poll = (registry: Registry, created: { requestId: string; pollSecret: string }) =>
  registry.pollPairingRequest({ requestId: created.requestId, pollSecret: created.pollSecret });

const stateOf = (registry: Registry) =>
  registry
    .get(registration.appId)
    .pipe(Effect.map((record) => Option.getOrThrow(record).status.state));

/** Pairs through the prompt and returns the delivered credential's token. */
const grant = (registry: Registry, input: typeof registration) =>
  Effect.gen(function* () {
    const created = yield* registry.createPairingRequest(input);
    yield* registry.decidePairing({ requestId: created.requestId, decision: "grant" });
    const { credential } = yield* poll(registry, created);
    if (credential === undefined) return yield* Effect.die("no credential delivered");
    return credential.token;
  });

it.layer(NodeServices.layer)("AppRegistryService", (it) => {
  it.effect("shows a new app's pairing request until it expires", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const events = yield* streamQueue(registry.streamStatus);
      assert.deepEqual(yield* Queue.take(events), { type: "snapshot", apps: [] });

      const created = yield* registry.createPairingRequest(registration);
      const pending = yield* Queue.take(events);
      assert.strictEqual(pending.type === "upsert" && pending.app.state, "pairing-requested");
      assert.strictEqual(
        pending.type === "upsert" && pending.app.pendingRequest?.requestId,
        created.requestId,
      );
      assert.isFalse(yield* registry.isGranted(registration.appId));

      const poll = (pollSecret: string) =>
        registry.pollPairingRequest({ requestId: created.requestId, pollSecret });
      assert.deepEqual(yield* poll(created.pollSecret), { state: "pairing-requested" });
      assert.strictEqual(errorCode(yield* Effect.exit(poll("wrong-secret"))), "not-found");

      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(yield* poll(created.pollSecret), { state: "expired" });
      // Clients drop the prompt from this upsert; they keep no timers of their own.
      const expired = yield* Queue.take(events);
      assert.isTrue(expired.type === "upsert" && expired.app.pendingRequest === null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("supersedes an earlier pairing request from the same app", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const first = yield* registry.createPairingRequest(registration);
      const second = yield* registry.createPairingRequest(registration);

      assert.deepEqual(
        yield* registry.pollPairingRequest({
          requestId: first.requestId,
          pollSecret: first.pollSecret,
        }),
        { state: "expired" },
      );
      assert.strictEqual((yield* registry.list)[0]?.pendingRequest?.requestId, second.requestId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses tool prefixes that Lecturn or another app already uses", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      for (const toolPrefix of ["preview", "lecturn", "apps", "worktree"]) {
        const exit = yield* Effect.exit(
          registry.createPairingRequest(makeRegistration({ toolPrefix })),
        );
        assert.strictEqual(errorCode(exit), "invalid", toolPrefix);
      }

      yield* registry.seedSidecarGrant(sidecar());
      const other = makeRegistration({ appId: "dev.other.app", name: "Other" });
      assert.strictEqual(
        errorCode(yield* Effect.exit(registry.createPairingRequest(other))),
        "conflict",
      );
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(registry.seedSidecarGrant({ ...sidecar(), registration: other })),
        ),
        "conflict",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("grants a sidecar's app and keeps its headless cache only for the same command", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      yield* registry.seedSidecarGrant(sidecar());
      assert.isTrue(yield* registry.isGranted(registration.appId));
      const record = yield* registry.get(registration.appId);
      assert.strictEqual(Option.getOrThrow(record).status.state, "granted");
      assert.isNotNull(Option.getOrThrow(record).status.lastSeenAt);

      assert.isTrue(Option.isNone((yield* registry.cachedTools(registration.appId)).headless));
      yield* registry.setCachedTools(registration.appId, "headless", headlessDefinitions);
      yield* registry.setCachedTools(registration.appId, "live", liveDefinitions);

      yield* registry.seedSidecarGrant(sidecar({ name: "Example 2" }));
      const kept = yield* registry.cachedTools(registration.appId);
      assert.deepEqual(
        Option.map(kept.headless, (tools) => tools.map((tool) => tool.name)),
        Option.some(["design"]),
      );

      yield* registry.seedSidecarGrant(
        sidecar({ headlessTools: { ...registration.headlessTools, args: ["serve"] } }),
      );
      const changed = yield* registry.cachedTools(registration.appId);
      assert.isTrue(Option.isNone(changed.headless));
      assert.isTrue(Option.isSome(changed.live));

      assert.isTrue(
        Option.isNone(yield* registry.get(makeRegistration({ appId: "dev.none.app" }).appId)),
      );
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(
            registry.cachedTools(makeRegistration({ appId: "dev.none.app" }).appId),
          ),
        ),
        "not-found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("grants the sidecar's own app at startup", () => {
    const { layer } = makeLayer({ appSidecar: sidecar() });
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      assert.isTrue(yield* registry.isGranted(registration.appId));
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes live definitions when a lease is established, not on each heartbeat", () => {
    const { layer, liveListCalls } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const leases = yield* AppLeaseService;
      yield* registry.seedSidecarGrant(sidecar());
      const events = yield* streamQueue(registry.streamStatus);
      yield* Queue.take(events);
      const nextLive = Queue.take(events).pipe(
        Effect.map((event) => (event.type === "upsert" ? event.app.live : "removed")),
      );

      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 1);
      const cached = yield* registry.cachedTools(registration.appId);
      assert.deepEqual(
        Option.map(cached.live, (tools) => tools.map((tool) => tool.name)),
        Option.some(["window_flash"]),
      );

      // Changes are handled in order, so the closing upsert proves the renewal before it listed nothing.
      yield* leases.set(registration.appId, liveLease);
      yield* leases.clear(registration.appId);
      assert.isNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 1);

      // Re-established after closing: a restarted app may serve new tools.
      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 2);

      yield* TestClock.adjust("20 seconds");
      assert.isNull(yield* nextLive);
    }).pipe(Effect.provide(layer));
  });

  it.effect("streams the embed context of an app project and refuses other projects", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const leases = yield* AppLeaseService;
      yield* registry.seedSidecarGrant(sidecar());

      const contexts = yield* streamQueue(registry.streamEmbedContext(appProject));
      const initial = yield* Queue.take(contexts);
      assert.strictEqual(initial.name, "Example");
      assert.isNull(initial.live);
      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull((yield* Queue.take(contexts)).live);

      const other = yield* Effect.exit(
        Stream.runCollect(registry.streamEmbedContext(ProjectId.make("project-plain"))),
      );
      assert.strictEqual(errorCode(other), "not-found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("delivers the credential of a granted request exactly once", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const sessions = yield* SessionStore.SessionStore;
      const created = yield* registry.createPairingRequest(registration);
      const status = yield* registry.decidePairing({
        requestId: created.requestId,
        decision: "grant",
      });
      assert.strictEqual(status.state, "granted");
      assert.isNull(status.pendingRequest);
      assert.isTrue(yield* registry.isGranted(registration.appId));

      const first = yield* poll(registry, created);
      assert.strictEqual(first.state, "granted");
      const credential = first.credential;
      assert.isDefined(credential);
      const verified = yield* sessions.verify(credential!.token);
      assert.strictEqual(verified.subject, "app:dev.example.app");
      assert.deepEqual(verified.scopes, ["apps:host"]);
      assert.isUndefined(verified.runtimeModeCeiling);

      assert.deepEqual(yield* poll(registry, created), { state: "granted" });
      // Answered prompts cannot be answered again, by this client or another.
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(
            registry.decidePairing({ requestId: created.requestId, decision: "deny" }),
          ),
        ),
        "not-found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("puts only runtime-mode ceilings into the credential", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const sessions = yield* SessionStore.SessionStore;
      const ceilingOf = (ceiling: "read-only" | "auto") =>
        Effect.gen(function* () {
          const created = yield* registry.createPairingRequest(registration);
          const status = yield* registry.setRuntimeCeiling({ appId: registration.appId, ceiling });
          assert.strictEqual(status.runtimeCeiling, ceiling);
          yield* registry.decidePairing({ requestId: created.requestId, decision: "grant" });
          const { credential } = yield* poll(registry, created);
          return (yield* sessions.verify(credential!.token)).runtimeModeCeiling;
        });
      assert.isUndefined(yield* ceilingOf("read-only"));
      assert.strictEqual(yield* ceilingOf("auto"), "auto");
      // The registry keeps the full ceiling, read-only included (D2).
      yield* registry.setRuntimeCeiling({ appId: registration.appId, ceiling: "read-only" });
      const record = Option.getOrThrow(yield* registry.get(registration.appId));
      assert.strictEqual(record.status.runtimeCeiling, "read-only");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends a changed command or listing command back to pending", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      yield* grant(registry, registration);
      yield* registry.setCachedTools(registration.appId, "headless", headlessDefinitions);

      // The same command asks for a new credential without suspending the grant.
      const same = yield* registry.createPairingRequest(makeRegistration({ name: "Example 2" }));
      assert.strictEqual(yield* stateOf(registry), "granted");
      yield* registry.decidePairing({ requestId: same.requestId, decision: "deny" });
      assert.strictEqual(yield* stateOf(registry), "granted");

      const approved = registration.headlessTools!;
      for (const headlessTools of [
        { ...approved, args: ["serve", "{workspaceRoot}"] },
        { ...approved, listArgs: ["tools", "{workspaceRoot}"] },
      ]) {
        const changed = makeRegistration({ headlessTools });
        const created = yield* registry.createPairingRequest(changed);
        assert.strictEqual(yield* stateOf(registry), "pairing-requested");
        assert.isFalse(yield* registry.isGranted(registration.appId));
        // Until the user decides, the record keeps the command they approved.
        const pending = Option.getOrThrow(yield* registry.get(registration.appId));
        assert.deepEqual(pending.registration.headlessTools, registration.headlessTools);
        assert.deepEqual(pending.status.pendingRequest?.registration.headlessTools, headlessTools);

        yield* registry.decidePairing({ requestId: created.requestId, decision: "grant" });
        const granted = Option.getOrThrow(yield* registry.get(registration.appId));
        assert.strictEqual(granted.status.state, "granted");
        assert.deepEqual(granted.registration.headlessTools, headlessTools);
        assert.isTrue(Option.isNone((yield* registry.cachedTools(registration.appId)).headless));
        yield* grant(registry, registration);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a denied app ask again", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const first = yield* registry.createPairingRequest(registration);
      const denied = yield* registry.decidePairing({
        requestId: first.requestId,
        decision: "deny",
      });
      assert.strictEqual(denied.state, "denied");
      assert.deepEqual(yield* poll(registry, first), { state: "denied" });

      const second = yield* registry.createPairingRequest(registration);
      assert.strictEqual(yield* stateOf(registry), "pairing-requested");
      yield* registry.decidePairing({ requestId: second.requestId, decision: "grant" });
      assert.isDefined((yield* poll(registry, second)).credential);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retires an app's credentials when it pairs again, is denied, or is revoked", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const sessions = yield* SessionStore.SessionStore;
      const leases = yield* AppLeaseService;
      const verifies = (token: string) =>
        sessions.verify(token).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

      const first = yield* grant(registry, registration);
      const second = yield* grant(registry, registration);
      assert.isFalse(yield* verifies(first));
      assert.isTrue(yield* verifies(second));

      const changed = yield* registry.createPairingRequest(
        makeRegistration({ headlessTools: { ...registration.headlessTools, args: ["serve"] } }),
      );
      yield* registry.decidePairing({ requestId: changed.requestId, decision: "deny" });
      assert.strictEqual(yield* stateOf(registry), "denied");
      assert.isFalse(yield* verifies(second));

      const third = yield* grant(registry, registration);
      yield* leases.set(registration.appId, liveLease);
      const revoked = yield* registry.revoke(registration.appId);
      assert.strictEqual(revoked.state, "revoked");
      assert.isNull(revoked.live);
      assert.isFalse(yield* verifies(third));
      assert.isTrue(Option.isNone(yield* leases.current(registration.appId)));
      assert.isFalse(yield* registry.isGranted(registration.appId));

      // A revoked app stays revoked until the user grants it again.
      const repair = yield* registry.createPairingRequest(registration);
      assert.strictEqual(yield* stateOf(registry), "revoked");
      yield* registry.decidePairing({ requestId: repair.requestId, decision: "grant" });
      assert.strictEqual(yield* stateOf(registry), "granted");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses decisions on expired requests", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const created = yield* registry.createPairingRequest(registration);
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(
            registry.decidePairing({ requestId: created.requestId, decision: "grant" }),
          ),
        ),
        "not-found",
      );
      assert.isFalse(yield* registry.isGranted(registration.appId));
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes an app and its credentials", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const sessions = yield* SessionStore.SessionStore;
      const token = yield* grant(registry, registration);
      const events = yield* streamQueue(registry.streamStatus);
      yield* Queue.take(events);

      const withThreads = yield* Effect.exit(
        registry.delete({ appId: registration.appId, deleteThreads: true }),
      );
      assert.isTrue(Exit.isFailure(withThreads));
      assert.isTrue(yield* registry.isGranted(registration.appId));

      yield* registry.delete({ appId: registration.appId, deleteThreads: false });
      assert.deepEqual(yield* Queue.take(events), { type: "remove", appId: registration.appId });
      assert.isTrue(Option.isNone(yield* registry.get(registration.appId)));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sessions.verify(token))));
      assert.strictEqual(
        errorCode(yield* Effect.exit(registry.revoke(registration.appId))),
        "not-found",
      );
    }).pipe(Effect.provide(layer));
  });
});

it("reserves the first segment of every built-in Lecturn tool name", () => {
  const toolkits = [
    AttachmentToolkit,
    DeviceToolkit,
    EnvironmentToolkit,
    HtmlToolkit,
    OrchestratorToolkit,
    PreviewToolkit,
    PreviewControlsToolkit,
    ProjectToolkit,
    PullRequestsToolkit,
    ThreadToolkit,
    WorktreeToolkit,
  ];
  const unreserved = toolkits
    .flatMap((toolkit) => Object.keys(toolkit.tools))
    .filter((name) => !RESERVED_APP_TOOL_PREFIXES.has(name.split("_")[0] ?? name));
  assert.deepEqual(unreserved, []);
});
