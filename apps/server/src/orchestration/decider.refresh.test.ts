import { CommandId, ProjectId, type OrchestrationReadModel } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const REFRESHED_AT = "2026-01-02T00:00:00.000Z";
const projectId = ProjectId.make("project-refresh");

function makeReadModel(deletedAt: string | null, projects = true): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: projects
      ? [
          {
            id: projectId,
            title: "Project",
            workspaceRoot: "/tmp/project-refresh",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt,
          },
        ]
      : [],
    threads: [],
    updatedAt: NOW,
  };
}

const command = {
  type: "project.refresh" as const,
  commandId: CommandId.make("server:stave:refresh:project-refresh:1"),
  projectId,
  createdAt: REFRESHED_AT,
};

it.layer(NodeServices.layer)("project.refresh decider", (it) => {
  it.effect("emits one project.refreshed for an active project", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "project.refreshed",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: REFRESHED_AT,
        commandId: command.commandId,
        payload: { projectId },
      });
    }),
  );

  it.effect("rejects a refresh for a deleted project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(NOW),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain(`Project '${projectId}' does not exist`);
    }),
  );

  it.effect("rejects a refresh for an unknown project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(null, false),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain(`Project '${projectId}' does not exist`);
    }),
  );
});
