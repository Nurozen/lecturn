import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
} from "@lecturn/contracts";
import { Effect, Layer } from "effect";
import { ServerConfig, layerTest } from "../config.ts";
import { NodeServices } from "@effect/platform-node";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary, StaveBinaryNotFound } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import { make } from "./StaveMergeSignal.ts";

const stamp = "2026-09-09T00:00:00.123456789Z";
const project: OrchestrationProjectShell = {
  id: ProjectId.make("p"),
  title: "m",
  workspaceRoot: "/spaces/m",
  defaultModelSelection: null,
  scripts: [],
  createdAt: stamp,
  updatedAt: stamp,
  stave: { spaceId: "m", createdAt: stamp, isSaga: false, state: "live", repos: [], memories: [] },
};
const manifest = (id: string) => ({ id, createdAt: stamp, repos: [], memories: [] });
const repo = (baseHealth: "merged" | "ok") => ({
  name: "r",
  branch: "b",
  base: "main",
  ahead: 0,
  behind: 0,
  baseHealth,
});

const harness = (
  options: {
    enabled?: boolean;
    killSwitch?: boolean;
    merge?: boolean;
    repos?: ("merged" | "ok")[];
    stamp?: string;
    state?: "live" | "missing";
    degraded?: boolean;
    binaryMissing?: boolean;
  } = {},
) =>
  Layer.mergeAll(
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        return { ...(yield* ServerConfig), staveEnabled: options.killSwitch ?? true };
      }),
    ).pipe(
      Layer.provide(layerTest(process.cwd(), { prefix: "stave-merge-test-" })),
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        stave: {
          ...DEFAULT_SERVER_SETTINGS.stave,
          enabled: options.enabled ?? true,
          lifecycle: {
            ...DEFAULT_SERVER_SETTINGS.stave.lifecycle,
            settleOnSagaMerge: options.merge ?? true,
          },
        },
      }),
    }),
    Layer.mock(StaveBinary)({
      resolve: options.binaryMissing
        ? Effect.fail(new StaveBinaryNotFound({ candidates: ["/configured/missing"] }))
        : Effect.succeed({
            path: "/bin/stave",
            source: "path",
            version: "v0.4.0",
            commit: null,
          }),
    }),
    Layer.mock(StaveCli)({
      sagaList: Effect.suspend(() => {
        expect(
          options.enabled !== false && options.killSwitch !== false && options.merge !== false,
        ).toBe(true);
        return Effect.succeed([
          { id: "s", logicalId: "s", path: "/spaces/s", isSaga: true, members: ["m"] },
        ]);
      }),
      spaceStatus: (id) =>
        Effect.succeed({
          spaceId: id,
          spacePath: `/spaces/${id}`,
          manifest:
            id === "s"
              ? {
                  ...manifest(id),
                  saga: {
                    members: [{ id: "m", createdAt: options.stamp ?? stamp, after: [], prs: [] }],
                  },
                }
              : manifest(id),
          repos: [],
          memories: [],
        }),
      sagaStatus: () =>
        Effect.succeed({
          sagaId: "s",
          notes: options.degraded ? [{ kind: "degraded", text: "probe unavailable" }] : [],
          members: [
            {
              id: "m",
              after: [],
              state: options.state ?? "live",
              dirty: false,
              repos: (options.repos ?? ["merged", "merged"]).map(repo),
              prs: [],
            },
          ],
        }),
    }),
  );

describe("StaveMergeSignal", () => {
  it.effect("requires every edit repo and the current enrolled incarnation", () =>
    Effect.gen(function* () {
      const signal = yield* make;
      expect([...(yield* signal.candidates([project]))]).toEqual([project.id]);
    }).pipe(Effect.provide(harness())),
  );
  for (const [name, options] of Object.entries({
    partial: { repos: ["merged", "ok"] as ("merged" | "ok")[] },
    empty: { repos: [] },
    reused: { stamp: "2026-09-09T00:00:00.123456788Z" },
    missing: { state: "missing" as const },
    degraded: { degraded: true },
    disabled: { enabled: false },
    killSwitch: { killSwitch: false },
    mergeOff: { merge: false },
    binaryMissing: { binaryMissing: true },
  })) {
    it.effect(`does not signal ${name}`, () =>
      Effect.gen(function* () {
        const signal = yield* make;
        expect([...(yield* signal.candidates([project]))]).toEqual([]);
      }).pipe(Effect.provide(harness(options))),
    );
  }
});
