import type { SquireSteerKind, ThreadPullRequestLink } from "@lecturn/contracts";

const TITLE_MAX_CHARS = 120;

const KIND_PHRASE: Readonly<Partial<Record<SquireSteerKind, string>>> = {
  rebase: "needs a rebase",
  "rerun-checks": "rerun checks",
  "fix-failing-check": "failing check",
  "address-review": "review feedback",
  continue: "continue",
};

/** What the PR shows now, worded as the reason a steer exists; null when nothing stands out. */
function pullRequestIssue(snapshot: NonNullable<ThreadPullRequestLink["snapshot"]>) {
  if (snapshot.state === "merged") return "merged";
  if (snapshot.state === "closed") return "closed";
  if (snapshot.checksState === "failing") return "required checks failing";
  if (snapshot.reviewDecision === "changes-requested") return "changes requested";
  if (snapshot.mergeability === "conflicting") return "merge conflicts";
  if (snapshot.checksState === "pending") return "checks running";
  return null;
}

const cut = (value: string) =>
  value.length <= TITLE_MAX_CHARS ? value : `${value.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;

/**
 * A steer card's title is a short summary (`billing-service #321: required checks failing`),
 * named by the project, the PR, and what changed, so the row reads at a glance; the
 * full steer stays in the payload and shows as the card's recommendation.
 */
export function squireSteerTitle(input: {
  readonly project: string;
  readonly threadTitle: string;
  readonly pullRequest: Pick<ThreadPullRequestLink, "number" | "snapshot"> | null;
  readonly steerKind: SquireSteerKind;
  readonly steer: string;
}): string {
  const where = input.project.trim() || input.threadTitle.trim();
  const kind = KIND_PHRASE[input.steerKind] ?? null;
  const pr = input.pullRequest;
  if (pr !== null && where !== "") {
    const issue = (pr.snapshot === null ? null : pullRequestIssue(pr.snapshot)) ?? kind;
    return cut(issue === null ? `${where} #${pr.number}` : `${where} #${pr.number}: ${issue}`);
  }
  const thread = input.threadTitle.trim();
  if (thread !== "" && kind !== null) return cut(`${thread}: ${kind}`);
  return cut(input.steer.split("\n")[0]!.trim());
}
