// @effect-diagnostics nodeBuiltinImport:off -- filesystem alias boundary test
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isPathUnder } from "./StaveSpaceLock.ts";

describe("Stave session root matching", () => {
  it.effect("matches descendants and aliases but excludes sibling prefixes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stave-path-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const space = NodePath.join(root, "demo");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(space, "repo"), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.symlink(space, NodePath.join(root, "alias")));
      expect(yield* isPathUnder(space, NodePath.join(space, "repo"))).toBe(true);
      expect(yield* isPathUnder(space, NodePath.join(root, "alias", "repo"))).toBe(true);
      expect(yield* isPathUnder(space, NodePath.join(root, "demo-two"))).toBe(false);
      expect(yield* isPathUnder(space, root)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
