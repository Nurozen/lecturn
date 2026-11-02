/**
 * Who answers a room post (P19.3): deterministic rules on every tier, first
 * match wins. Pure: `SquireRooms` gathers the members, scope cover, recent
 * posts, and switches, and applies the decision.
 *
 * (a) `@Name` mentions, (b) a reply to or quote of a member's post, (c) refs
 * all covered by exactly one member's scope, (d) a user post within 2 min of
 * a member's post, (e) the Lead. The author is never a recipient, a match on
 * the user wakes nobody, a paused match goes to the Lead, and nothing fans out.
 */
import type {
  SquireId,
  SquireParticipant,
  SquireRef,
  SquireRouting,
  SquireStatus,
} from "@lecturn/contracts";

const RECENT_REPLY_WINDOW_MS = 2 * 60 * 1000;

export interface RoutingMember {
  readonly squireId: SquireId;
  readonly name: string;
  readonly status: SquireStatus;
}

/** A ref the post names: an explicit ref, or a `#<n>` PR number found in the body. */
export type RoutingRef = Exclude<SquireRef, { readonly kind: "item" }>;

export interface RoomRoutingInput {
  readonly author: SquireParticipant;
  readonly body: string;
  /** Explicit refs; `#<n>` numbers in the body are added by `routeRoomPost`. */
  readonly refs: ReadonlyArray<SquireRef>;
  /** The author of the post this replies to, when it is a reply. */
  readonly replyToAuthor: SquireParticipant | null;
  /** Authors of earlier room posts the body quotes (`> ` lines, see `quotedLines`). */
  readonly quotedAuthors: ReadonlyArray<SquireParticipant>;
  /** Squire members only, in member order; the Lead and the user are apart. */
  readonly members: ReadonlyArray<RoutingMember>;
  readonly lead: { readonly squireId: SquireId; readonly name: string } | null;
  /** The room's bot messaging and the environment switch (P19.1), both on. */
  readonly botMessagingOn: boolean;
  /** Members whose scope covers the ref (SquireScope); empty for none. */
  readonly coverOf: (ref: RoutingRef) => ReadonlyArray<SquireId>;
  /** Squire members' posts in this room, newest first (rule d). */
  readonly recentMemberPosts: ReadonlyArray<{
    readonly squireId: SquireId;
    readonly createdAt: string;
  }>;
  readonly now: string;
}

export interface RoomRoutingDecision {
  /** Rule kinds only; Jev and fallbacks are applied later by `SquireJevRouting`. */
  readonly via: Extract<SquireRouting["via"], { readonly kind: "rule" }>;
  /** Squire or Lead ids to wake; empty wakes nobody. */
  readonly recipients: ReadonlyArray<SquireId>;
  /** Rule (e) delivered to the Lead, so Jev may retarget it on the funded tier (P19.4). */
  readonly jevEligible: boolean;
}

/** The text of each `> ` quoted line, trimmed, for matching against earlier posts. */
export function quotedLines(body: string): ReadonlyArray<string> {
  const lines: Array<string> = [];
  for (const line of body.split(/\r?\n/)) {
    const quoted = QUOTE_PREFIX.exec(line);
    if (quoted === null) continue;
    const text = line.slice(quoted[0].length).trim();
    if (text.length > 0) lines.push(text);
  }
  return lines;
}

export function routeRoomPost(input: RoomRoutingInput): RoomRoutingDecision {
  const isBot = input.author.kind === "squire" || input.author.kind === "lead";
  if (isBot && !input.botMessagingOn) return nobody("bot messaging off");

  const ctx = routingContext(input);
  // Quoted text is someone else's words: its mentions and PR numbers do not
  // address anyone, the quote itself routes by rule (b).
  const ownText = unquoted(input.body);

  const mentioned = mentionTargets(ownText, ctx);
  const byMention = resolve(ctx, "mention", mentioned, (names) =>
    names.map((name) => `@${name}`).join(" "),
  );
  if (byMention !== null) return byMention;

  const replied = [input.replyToAuthor, ...input.quotedAuthors].flatMap((participant) =>
    participant === null ? [] : participantTarget(participant, ctx),
  );
  const byReply = resolve(
    ctx,
    "reply",
    replied,
    (names) => `${input.replyToAuthor === null ? "quote of" : "reply to"} ${names.join(", ")}`,
    "reply to you",
  );
  if (byReply !== null) return byReply;

  const refs = routingRefs(input.refs, ownText);
  const owner = soleCover(refs, input);
  if (owner !== null) {
    const byScope = resolve(ctx, "scope", [owner], () => `named ${describeRefs(refs)}`);
    if (byScope !== null) return byScope;
  }

  if (input.author.kind === "user") {
    const recent = recentTarget(input, ctx);
    if (recent !== null) {
      const byRecent = resolve(ctx, "recent", [recent], (names) => `within 2 min of ${names[0]}`);
      if (byRecent !== null) return byRecent;
    }
  }

  if (input.lead === null) return nobody("no Lead");
  if (ctx.authorId === input.lead.squireId) return nobody("posted by the Lead");
  return {
    via: { kind: "rule", rule: "lead", match: "no rule matched" },
    recipients: [input.lead.squireId],
    jevEligible: true,
  };
}

const QUOTE_PREFIX = /^\s*(?:>\s?)+/;
const PR_NUMBER = /(?<![\p{L}\p{N}_&#])#(\d+)(?![\p{L}\p{N}_])/gu;
const NAME_CHAR = /[\p{L}\p{N}_]/u;

type Target =
  | { readonly kind: "member"; readonly member: RoutingMember }
  | { readonly kind: "lead" }
  | { readonly kind: "user" };

interface RoutingContext {
  readonly members: ReadonlyArray<RoutingMember>;
  readonly lead: RoomRoutingInput["lead"];
  readonly authorId: SquireId | null;
  readonly authorIsUser: boolean;
}

function routingContext(input: RoomRoutingInput): RoutingContext {
  const author = input.author;
  return {
    members: input.members,
    lead: input.lead,
    authorId: author.kind === "squire" || author.kind === "lead" ? author.squireId : null,
    authorIsUser: author.kind === "user",
  };
}

function nobody(match: string): RoomRoutingDecision {
  return { via: { kind: "rule", rule: "none", match }, recipients: [], jevEligible: false };
}

function unquoted(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !QUOTE_PREFIX.test(line))
    .join("\n");
}

/**
 * Applies the constraints every rule shares: drop the author, a user-only
 * match wakes nobody, paused members go to the Lead. Null when nothing is
 * left, so the next rule gets its turn.
 */
function resolve(
  ctx: RoutingContext,
  rule: Exclude<RoomRoutingDecision["via"]["rule"], "lead" | "none">,
  targets: ReadonlyArray<Target>,
  describe: (names: ReadonlyArray<string>) => string,
  userOnlyMatch = "addresses only you",
): RoomRoutingDecision | null {
  const kept = targets.filter((target) =>
    target.kind === "user"
      ? !ctx.authorIsUser
      : target.kind === "lead"
        ? ctx.lead !== null && ctx.lead.squireId !== ctx.authorId
        : target.member.squireId !== ctx.authorId,
  );
  if (kept.length === 0) return null;

  const members = ctx.members.filter((member) =>
    kept.some((target) => target.kind === "member" && target.member.squireId === member.squireId),
  );
  const active = members.filter((member) => member.status === "active");
  const paused = members.filter((member) => member.status !== "active");
  const leadNamed = kept.some((target) => target.kind === "lead");
  if (active.length === 0 && paused.length === 0 && !leadNamed) return nobody(userOnlyMatch);

  const lead = ctx.lead;
  const leadReachable = lead !== null && lead.squireId !== ctx.authorId;
  const wakesLead = leadReachable && (leadNamed || paused.length > 0);
  const recipients = [
    ...active.map((member) => member.squireId),
    ...(wakesLead ? [lead.squireId] : []),
  ];

  const named = [...active.map((member) => member.name), ...(leadNamed && lead ? [lead.name] : [])];
  const pausedNote =
    paused.length === 0
      ? null
      : `${paused.map((member) => member.name).join(", ")} ${paused.length === 1 ? "is" : "are"} paused${leadReachable ? " · sent to Lead" : ""}`;
  const match = [named.length > 0 ? describe(named) : null, pausedNote]
    .filter((part) => part !== null)
    .join(" · ");

  if (recipients.length === 0) return nobody(match);
  return { via: { kind: "rule", rule, match }, recipients, jevEligible: false };
}

function participantTarget(participant: SquireParticipant, ctx: RoutingContext): Array<Target> {
  switch (participant.kind) {
    case "user":
      return [{ kind: "user" }];
    case "system":
      return [];
    case "lead":
    case "squire": {
      if (ctx.lead !== null && participant.squireId === ctx.lead.squireId)
        return [{ kind: "lead" }];
      const member = ctx.members.find((candidate) => candidate.squireId === participant.squireId);
      return member === undefined ? [] : [{ kind: "member", member }];
    }
  }
}

function mentionTargets(text: string, ctx: RoutingContext): Array<Target> {
  // Members first so a member named like an alias wins the tie; longest name
  // first so "Release Notes" beats "Release".
  const names: Array<{ readonly name: string; readonly target: Target }> = [
    ...ctx.members.map((member) => ({
      name: member.name,
      target: { kind: "member", member } as const,
    })),
    ...(ctx.lead === null
      ? []
      : [
          { name: ctx.lead.name, target: { kind: "lead" } as const },
          { name: "Lead", target: { kind: "lead" } as const },
        ]),
    { name: "you", target: { kind: "user" } as const },
  ]
    .filter((candidate) => candidate.name.trim().length > 0)
    .toSorted((left, right) => right.name.length - left.name.length);

  const lower = text.toLowerCase();
  const targets: Array<Target> = [];
  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && NAME_CHAR.test(text.charAt(at - 1))) continue;
    const start = at + 1;
    const hit = names.find((candidate) => {
      const end = start + candidate.name.length;
      return (
        lower.slice(start, end) === candidate.name.toLowerCase() &&
        !NAME_CHAR.test(text.charAt(end))
      );
    });
    if (hit !== undefined) targets.push(hit.target);
  }
  return targets;
}

function routingRefs(refs: ReadonlyArray<SquireRef>, text: string): Array<RoutingRef> {
  const explicit = refs.filter((ref): ref is RoutingRef => ref.kind !== "item");
  const named = [...text.matchAll(PR_NUMBER)]
    .map((found) => Number(found[1]))
    .filter((number) => Number.isSafeInteger(number) && number >= 1)
    .map((number): RoutingRef => ({ kind: "pullRequest", number }));
  return [...explicit, ...named];
}

function soleCover(refs: ReadonlyArray<RoutingRef>, input: RoomRoutingInput): Target | null {
  let owner: RoutingMember | null = null;
  for (const ref of refs) {
    const covering = input.members.filter((member) => input.coverOf(ref).includes(member.squireId));
    const only = covering.length === 1 ? covering[0] : undefined;
    if (only === undefined) return null;
    if (owner !== null && owner.squireId !== only.squireId) return null;
    owner = only;
  }
  return owner === null ? null : { kind: "member", member: owner };
}

function describeRefs(refs: ReadonlyArray<RoutingRef>): string {
  const prs = [...new Set(refs.flatMap((ref) => (ref.kind === "pullRequest" ? [ref.number] : [])))];
  const threads = new Set(refs.flatMap((ref) => (ref.kind === "thread" ? [ref.threadId] : [])))
    .size;
  const projects = new Set(refs.flatMap((ref) => (ref.kind === "project" ? [ref.projectId] : [])))
    .size;
  const count = (n: number, noun: string) => (n === 1 ? `a ${noun}` : `${n} ${noun}s`);
  return [
    ...(prs.length > 0 ? [`PR ${prs.map((number) => `#${number}`).join(", ")}`] : []),
    ...(threads > 0 ? [count(threads, "thread")] : []),
    ...(projects > 0 ? [count(projects, "project")] : []),
  ].join(", ");
}

function recentTarget(input: RoomRoutingInput, ctx: RoutingContext): Target | null {
  const now = Date.parse(input.now);
  for (const post of input.recentMemberPosts) {
    const age = now - Date.parse(post.createdAt);
    // Newest first, so the first post past the window ends the search.
    if (!(age <= RECENT_REPLY_WINDOW_MS)) return null;
    if (age < 0) continue;
    const member = ctx.members.find((candidate) => candidate.squireId === post.squireId);
    if (member !== undefined) return { kind: "member", member };
  }
  return null;
}
