/**
 * Server-side filtering of shell data for `app:` and `embed:` sessions, so a
 * connected app never learns about projects it does not own. Every entry
 * point returns its input untouched for other sessions: their payloads stay
 * byte-identical and pay no per-item work.
 */
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  ProjectId,
  ProjectSnapshot,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AppAuthorization } from "./services.ts";
import { type AppSubject, parseAppSubject } from "./subjects.ts";

/** Project shells carry their binding, so ownership needs no lookup. */
export const ownsProjectShell = (
  subject: AppSubject,
  project: Pick<OrchestrationProjectShell, "id" | "appBinding">,
): boolean =>
  project.appBinding?.appId === subject.appId &&
  (subject.kind === "app" || project.id === subject.projectId);

export const filterShellSnapshot = (
  subject: AppSubject,
  snapshot: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot => {
  const projects = snapshot.projects.filter((project) => ownsProjectShell(subject, project));
  const visible = new Set<ProjectId>(projects.map((project) => project.id));
  return {
    ...snapshot,
    projects,
    threads: snapshot.threads.filter((thread) => visible.has(thread.projectId)),
    archivedThreads: snapshot.archivedThreads.filter((thread) => visible.has(thread.projectId)),
  };
};

/**
 * `ownsProject` is asked only for a thread update outside an embed token's
 * own project check. Removals pass: they carry an id the client either
 * already holds or ignores.
 */
export const filterShellItem = <E, R>(
  subject: AppSubject,
  item: OrchestrationV2ShellStreamItem,
  ownsProject: (projectId: ProjectId) => Effect.Effect<boolean, E, R>,
): Effect.Effect<Option.Option<OrchestrationV2ShellStreamItem>, E, R> => {
  switch (item.kind) {
    case "snapshot":
      return Effect.succeedSome({ ...item, snapshot: filterShellSnapshot(subject, item.snapshot) });
    case "project.updated":
      return Effect.succeed(
        ownsProjectShell(subject, item.project) ? Option.some(item) : Option.none(),
      );
    case "thread.updated": {
      if (subject.kind === "embed") {
        // Embed tokens are minted only for a project bound to their app.
        return Effect.succeed(
          item.thread.projectId === subject.projectId ? Option.some(item) : Option.none(),
        );
      }
      return ownsProject(item.thread.projectId).pipe(
        Effect.map((owned) => (owned ? Option.some(item) : Option.none())),
      );
    }
    case "synchronized":
    case "project.removed":
    case "thread.removed":
      return Effect.succeedSome(item);
  }
};

export const filterShellStream =
  (session: AuthenticatedSession) =>
  <E, R>(
    stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
  ): Stream.Stream<OrchestrationV2ShellStreamItem, E, R | AppAuthorization> =>
    parseAppSubject(session.subject) === null
      ? stream
      : Stream.unwrap(
          Effect.service(AppAuthorization).pipe(
            Effect.map((apps) =>
              stream.pipe(
                Stream.mapEffect((item) => apps.filterShellItem(session, item)),
                Stream.filter(Option.isSome),
                Stream.map((item) => item.value),
              ),
            ),
          ),
        );

/** For the HTTP shell snapshot, which has the subject but no apps services in reach. */
export const filterShellSnapshotForSubject =
  (subject: string) =>
  (snapshot: OrchestrationV2ShellSnapshot): OrchestrationV2ShellSnapshot => {
    const app = parseAppSubject(subject);
    return app === null ? snapshot : filterShellSnapshot(app, snapshot);
  };

/**
 * `/api/projects` rows carry no binding. Only embed tokens reach the route,
 * and an embed token's project is the one project it may see.
 */
export const filterProjectSnapshotForSubject =
  (subject: string) =>
  (snapshot: ProjectSnapshot): ProjectSnapshot => {
    const app = parseAppSubject(subject);
    if (app === null) return snapshot;
    return {
      ...snapshot,
      projects:
        app.kind === "embed"
          ? snapshot.projects.filter((project) => project.id === app.projectId)
          : [],
    };
  };
