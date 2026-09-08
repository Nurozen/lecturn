import type { OrchestrationProjectShell, ServerConfig } from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  createEnvironmentServerConfigsAtom,
  createEnvironmentShellSummaryAtom,
  findProjectVisibleAtSequence,
  ProjectNotVisibleError,
  waitForProjectVisible,
} from "./shell.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

function environmentEntry(environmentId: EnvironmentId, label: string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    }),
    profile: Option.none(),
  };
}

function shellState(input: {
  readonly status: EnvironmentShellState["status"];
  readonly updatedAt?: string;
  readonly error?: string;
  readonly snapshotSequence?: number;
}): EnvironmentShellState {
  return {
    snapshot:
      input.updatedAt === undefined
        ? Option.none()
        : Option.some({
            snapshotSequence: input.snapshotSequence ?? 1,
            updatedAt: input.updatedAt,
            projects: [],
            threads: [],
          }),
    status: input.status,
    error: input.error === undefined ? Option.none() : Option.some(input.error),
  };
}

function makeHarness() {
  const shellStateAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(
      environmentId === ENVIRONMENT_ID
        ? shellState({
            status: "cached",
            updatedAt: "2026-06-01T00:00:00.000Z",
          })
        : shellState({
            status: "synchronizing",
            updatedAt: "2026-06-02T00:00:00.000Z",
            error: "Retrying.",
          }),
    ),
  );
  const configAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ServerConfig | null>(null),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [ENVIRONMENT_ID, environmentEntry(ENVIRONMENT_ID, "Environment")],
      [OTHER_ENVIRONMENT_ID, environmentEntry(OTHER_ENVIRONMENT_ID, "Other environment")],
    ]),
  });
  const summaryAtom = createEnvironmentShellSummaryAtom({
    catalogValueAtom,
    shellStateValueAtom: shellStateAtoms,
  });
  const serverConfigsAtom = createEnvironmentServerConfigsAtom({
    catalogValueAtom,
    serverConfigValueAtom: configAtoms,
  });

  return {
    registry: AtomRegistry.make(),
    shellStateAtom: shellStateAtoms,
    configAtom: configAtoms,
    summaryAtom,
    serverConfigsAtom,
  };
}

describe("environment shell projections", () => {
  it("summarizes shell state and preserves identity when only irrelevant snapshot data changes", () => {
    const harness = makeHarness();
    const summary = harness.registry.get(harness.summaryAtom);

    expect(summary).toEqual({
      hasSnapshot: true,
      hasSynchronizingShell: true,
      hasCachedShell: true,
      hasLiveShell: false,
      firstError: "Retrying.",
      latestSnapshotUpdatedAt: "2026-06-02T00:00:00.000Z",
    });

    harness.registry.set(
      harness.shellStateAtom(ENVIRONMENT_ID),
      shellState({
        status: "cached",
        updatedAt: "2026-06-01T00:00:00.000Z",
        snapshotSequence: 2,
      }),
    );

    expect(harness.registry.get(harness.summaryAtom)).toBe(summary);
  });

  it("preserves server-config map identity until a config reference changes", () => {
    const harness = makeHarness();
    const empty = harness.registry.get(harness.serverConfigsAtom);
    const config = { cwd: "/repo" } as ServerConfig;

    harness.registry.set(harness.configAtom(ENVIRONMENT_ID), config);
    const withConfig = harness.registry.get(harness.serverConfigsAtom);

    expect(withConfig).not.toBe(empty);
    expect(withConfig.get(ENVIRONMENT_ID)).toBe(config);

    harness.registry.set(harness.configAtom(ENVIRONMENT_ID), config);
    expect(harness.registry.get(harness.serverConfigsAtom)).toBe(withConfig);
  });
});

describe("project visibility at a sequence", () => {
  const projectId = ProjectId.make("project-1");
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Demo",
    workspaceRoot: "/work/demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
  const withProject = (snapshotSequence: number): EnvironmentShellState => ({
    snapshot: Option.some({
      snapshotSequence,
      updatedAt: "2026-01-01T00:00:00.000Z",
      projects: [project],
      threads: [],
    }),
    status: "live",
    error: Option.none(),
  });

  it("only reports the project once the snapshot reached the create sequence", () => {
    const target = { projectId, sequence: 7 };
    expect(findProjectVisibleAtSequence(shellState({ status: "empty" }), target)).toBeNull();
    expect(findProjectVisibleAtSequence(withProject(6), target)).toBeNull();
    expect(findProjectVisibleAtSequence(withProject(7), target)).toEqual(project);
    expect(
      findProjectVisibleAtSequence(withProject(9), {
        projectId: ProjectId.make("other"),
        sequence: 7,
      }),
    ).toBeNull();
  });

  it.effect("resolves immediately when the store is already caught up", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const stateAtom = Atom.make(withProject(7));

      const visible = yield* waitForProjectVisible({ registry, stateAtom, projectId, sequence: 7 });

      expect(visible).toEqual(project);
      registry.dispose();
    }),
  );

  it.effect("resolves once a later shell state carries the project at the sequence", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const stateAtom = Atom.make(withProject(3));
      const waiting = yield* Effect.forkChild(
        waitForProjectVisible({ registry, stateAtom, projectId, sequence: 7 }),
      );
      yield* Effect.yieldNow;

      registry.set(stateAtom, withProject(5));
      registry.set(stateAtom, withProject(8));

      expect(yield* Fiber.join(waiting)).toEqual(project);
      registry.dispose();
    }),
  );

  it.effect("fails once the timeout elapses without the project", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const stateAtom = Atom.make(withProject(3));
      const waiting = yield* Effect.forkChild(
        waitForProjectVisible({
          registry,
          stateAtom,
          projectId,
          sequence: 7,
          timeout: "2 seconds",
        }),
      );
      yield* TestClock.adjust("2 seconds");

      const error = yield* Fiber.join(waiting).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotVisibleError);
      expect(error.sequence).toBe(7);
      registry.dispose();
    }),
  );
});
