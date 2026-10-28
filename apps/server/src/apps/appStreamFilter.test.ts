import {
  AppId,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectSnapshot,
  ServerSettings,
} from "@lecturn/contracts";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import {
  filterProjectSnapshotForSubject,
  filterServerSettingsForSubject,
  filterShellItem,
  filterShellSnapshotForSubject,
  filterShellStream,
} from "./appStreamFilter.ts";
import { AppAuthorization } from "./services.ts";
import { type AppSubject, formatAppSubject, formatEmbedSubject } from "./subjects.ts";

const rocketwright = AppId.make("dev.rocketwright.app");
const otherApp = AppId.make("dev.other.app");
const rocketProject = ProjectId.make("rocket-project");
const rocketSecondProject = ProjectId.make("rocket-second-project");
const otherAppProject = ProjectId.make("other-app-project");
const normalProject = ProjectId.make("normal-project");

// Only the fields the filter reads; the rest of a shell is irrelevant to ownership.
const project = (id: ProjectId, appId?: AppId) =>
  ({
    id,
    title: id,
    workspaceRoot: `/work/${id}`,
    ...(appId === undefined ? {} : { appBinding: { appId, workspaceRoot: `/work/${id}` } }),
  }) as unknown as OrchestrationProjectShell;

const thread = (id: string, projectId: ProjectId) =>
  ({ id: ThreadId.make(id), projectId, title: id }) as unknown as OrchestrationV2ThreadShell;

const snapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 7,
  projects: [
    project(rocketProject, rocketwright),
    project(rocketSecondProject, rocketwright),
    project(otherAppProject, otherApp),
    project(normalProject),
  ],
  threads: [
    thread("rocket-thread", rocketProject),
    thread("rocket-second-thread", rocketSecondProject),
    thread("other-thread", otherAppProject),
    thread("normal-thread", normalProject),
  ],
  archivedThreads: [
    thread("normal-archived", normalProject),
    thread("rocket-archived", rocketProject),
  ],
};

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);

const appSubject: AppSubject = { kind: "app", appId: rocketwright };
const embedSubject: AppSubject = { kind: "embed", appId: rocketwright, projectId: rocketProject };

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

const session = (subject: string): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-1"),
  subject,
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope],
});

const ownedByRocketwright = (projectId: ProjectId) =>
  Effect.succeed(projectId === rocketProject || projectId === rocketSecondProject);

describe("app shell filter", () => {
  it.effect("narrows a snapshot to the subject's projects and their threads", () =>
    Effect.gen(function* () {
      const forApp = yield* filterShellItem(
        appSubject,
        { kind: "snapshot", snapshot },
        ownedByRocketwright,
      );
      const appSnapshot = Option.getOrThrow(forApp);
      expect(appSnapshot.kind === "snapshot" && ids(appSnapshot.snapshot.projects)).toEqual([
        rocketProject,
        rocketSecondProject,
      ]);
      expect(appSnapshot.kind === "snapshot" && ids(appSnapshot.snapshot.threads)).toEqual([
        "rocket-thread",
        "rocket-second-thread",
      ]);

      const forEmbed = filterShellSnapshotForSubject(
        formatEmbedSubject(rocketwright, rocketProject),
      )(snapshot);
      expect(ids(forEmbed.projects)).toEqual([rocketProject]);
      expect(ids(forEmbed.threads)).toEqual(["rocket-thread"]);
      expect(ids(forEmbed.archivedThreads)).toEqual(["rocket-archived"]);
      expect(forEmbed.snapshotSequence).toBe(7);
    }),
  );

  it.effect("drops updates for foreign projects", () =>
    Effect.gen(function* () {
      const keep = (subject: AppSubject, item: OrchestrationV2ShellStreamItem) =>
        filterShellItem(subject, item, ownedByRocketwright).pipe(Effect.map(Option.isSome));
      const projectUpdate = (id: ProjectId, appId?: AppId): OrchestrationV2ShellStreamItem => ({
        kind: "project.updated",
        sequence: 8,
        project: project(id, appId),
      });
      const threadUpdate = (projectId: ProjectId): OrchestrationV2ShellStreamItem => ({
        kind: "thread.updated",
        sequence: 9,
        location: "active",
        thread: thread("t", projectId),
      });

      expect(yield* keep(appSubject, projectUpdate(rocketSecondProject, rocketwright))).toBe(true);
      expect(yield* keep(appSubject, projectUpdate(otherAppProject, otherApp))).toBe(false);
      expect(yield* keep(appSubject, projectUpdate(normalProject))).toBe(false);
      expect(yield* keep(embedSubject, projectUpdate(rocketSecondProject, rocketwright))).toBe(
        false,
      );
      expect(yield* keep(appSubject, threadUpdate(rocketSecondProject))).toBe(true);
      expect(yield* keep(appSubject, threadUpdate(normalProject))).toBe(false);
      expect(yield* keep(embedSubject, threadUpdate(rocketProject))).toBe(true);
      expect(yield* keep(embedSubject, threadUpdate(rocketSecondProject))).toBe(false);
      expect(yield* keep(embedSubject, { kind: "synchronized" })).toBe(true);
    }),
  );

  it("leaves ordinary sessions' shell data untouched", () => {
    const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
      { kind: "snapshot", snapshot },
      { kind: "synchronized" },
    ];
    const source = Stream.fromIterable(items);
    // The same stream value: no per-item work and byte-identical frames.
    expect(filterShellStream(session("owner"))(source)).toBe(source);
    expect(filterShellSnapshotForSubject("owner")(snapshot)).toBe(snapshot);
    const projects = { projects: [], updatedAt: "now" } as unknown as ProjectSnapshot;
    expect(filterProjectSnapshotForSubject("owner")(projects)).toBe(projects);
  });

  it.effect("filters an app session's stream through the apps service", () =>
    Effect.gen(function* () {
      const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
        { kind: "project.updated", sequence: 1, project: project(otherAppProject, otherApp) },
        { kind: "project.updated", sequence: 2, project: project(rocketProject, rocketwright) },
      ];
      const apps = Layer.succeed(AppAuthorization)({
        authorizeRpc: () => Effect.void,
        authorizeHttp: () => Effect.void,
        mintEmbedToken: () => Effect.die("unused"),
        filterShellItem: (_session, item) => filterShellItem(appSubject, item, ownedByRocketwright),
      });
      const kept = yield* filterShellStream(session(formatAppSubject(rocketwright)))(
        Stream.fromIterable(items),
      ).pipe(Stream.runCollect, Effect.provide(apps));
      expect(kept.map((item) => item.kind === "project.updated" && item.sequence)).toEqual([2]);
    }),
  );

  it("shows an embed only its own row in /api/projects", () => {
    const projects = {
      projects: [{ id: rocketProject }, { id: rocketSecondProject }, { id: normalProject }],
      updatedAt: "now",
    } as unknown as ProjectSnapshot;
    expect(
      ids(
        filterProjectSnapshotForSubject(formatEmbedSubject(rocketwright, rocketProject))(projects)
          .projects,
      ),
    ).toEqual([rocketProject]);
    expect(
      filterProjectSnapshotForSubject(formatAppSubject(rocketwright))(projects).projects,
    ).toEqual([]);
  });
});

describe("app server settings filter", () => {
  const script = (id: string) => ({
    id,
    name: id,
    command: `./${id}.sh`,
    icon: "play",
    runOnWorktreeCreate: false,
  });
  const hostSettings = decodeSettings({
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
    projectSettingsOverrides: {
      [rocketProject]: { defaultAutoPull: true, defaultProjectScripts: [script("simulate")] },
      [normalProject]: { defaultAutoPull: false, defaultProjectScripts: [script("deploy")] },
    },
    projectScriptOverrides: {
      [rocketProject]: [script("simulate")],
      [normalProject]: [script("deploy")],
    },
    projectAutoPullOverrides: { [rocketProject]: true, [normalProject]: false },
    projectAgentBrowserAccessOverrides: { [normalProject]: true },
    deviceHosts: [{ id: "lab", label: "Lab Mac", target: "me@lab.example" }],
  });

  it("shows an embed only its own project's settings and no saved SSH hosts", () => {
    const forEmbed = filterServerSettingsForSubject(
      formatEmbedSubject(rocketwright, rocketProject),
    )(hostSettings);
    expect(Object.keys(forEmbed.projectSettingsOverrides)).toEqual([rocketProject]);
    expect(Object.keys(forEmbed.projectScriptOverrides)).toEqual([rocketProject]);
    expect(Object.keys(forEmbed.projectAutoPullOverrides)).toEqual([rocketProject]);
    expect(forEmbed.projectAgentBrowserAccessOverrides).toEqual({});
    expect(forEmbed.deviceHosts).toEqual([]);
    // The embed's chat view resolves its project exactly as before.
    expect(resolveProjectSettings(forEmbed, rocketProject).overrides).toEqual(
      resolveProjectSettings(hostSettings, rocketProject).overrides,
    );
    expect(forEmbed.defaultModelSelection).toEqual(hostSettings.defaultModelSelection);
    // Clients decode the narrowed settings as they decode the full ones.
    expect(decodeSettings(encodeSettings(forEmbed))).toEqual(forEmbed);

    const forApp = filterServerSettingsForSubject(formatAppSubject(rocketwright))(hostSettings);
    expect(forApp.projectSettingsOverrides).toEqual({});
    expect(forApp.deviceHosts).toEqual([]);
    expect(filterServerSettingsForSubject("owner")(hostSettings)).toBe(hostSettings);
  });
});
