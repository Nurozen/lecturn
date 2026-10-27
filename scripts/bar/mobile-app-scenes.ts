/**
 * The mobile Apps scene (A43). A simulator has no clock or DOM to probe, so
 * the scene asserts the server's live states instead: the two working
 * threads, the pending approval, the sections, and Embed Host's lease, before
 * the deep link opens and again before the frame is kept.
 */
import { type BarAppManifest, barAppLiveStateProblems } from "./app-fixture.ts";

type ShellForCheck = Parameters<typeof barAppLiveStateProblems>[0];

interface AppForCheck {
  readonly appId: string;
  readonly state: string;
  readonly live: unknown;
}

/** `lecturn://apps/<appId>`: the app's thread list. */
export function barAppDeepLink(scheme: string, manifest: Pick<BarAppManifest, "appId">): string {
  return `${scheme}://apps/${encodeURIComponent(manifest.appId)}`;
}

/** `lecturn://apps/<appId>/threads/<environmentId>/<threadId>`: one app thread. */
export function barAppThreadDeepLink(
  scheme: string,
  manifest: Pick<BarAppManifest, "appId" | "environmentId">,
  threadId: string,
): string {
  return `${barAppDeepLink(scheme, manifest)}/threads/${encodeURIComponent(manifest.environmentId)}/${encodeURIComponent(threadId)}`;
}

/**
 * Everything that would make the frame lie: an expired approval, drifted live
 * states, or Embed Host leased when the scene draws it closed (or the reverse).
 */
export function mobileAppSceneProblems(input: {
  readonly manifest: BarAppManifest;
  readonly snapshot: ShellForCheck;
  readonly apps: ReadonlyArray<AppForCheck>;
  readonly running: boolean;
  readonly now: number;
}): ReadonlyArray<string> {
  const { manifest } = input;
  const problems: Array<string> = [];
  if (input.now >= Date.parse(manifest.approvalExpiresAt)) {
    problems.push(
      `the staged approval expired at ${manifest.approvalExpiresAt}; seed a fresh base dir with --app`,
    );
  }
  problems.push(...barAppLiveStateProblems(input.snapshot, manifest));
  const app = input.apps.find((entry) => entry.appId === manifest.appId);
  if (app?.state !== "granted") {
    problems.push(`${manifest.appName} is ${JSON.stringify(app?.state)}, not granted`);
  } else if (input.running !== (app.live != null)) {
    problems.push(
      `${manifest.appName} should read ${input.running ? "Running" : "Closed"}, but its lease is ${app.live == null ? "clear" : "live"}`,
    );
  }
  return problems;
}
