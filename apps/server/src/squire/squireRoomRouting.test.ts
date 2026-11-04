import { describe, expect, it } from "@effect/vitest";
import { SquireId, ThreadId } from "@lecturn/contracts";

import { type RoomRoutingInput, quotedLines, routeRoomPost } from "./squireRoomRouting.ts";

const release = SquireId.make("sq_release");
const research = SquireId.make("sq_research");
const leadId = SquireId.make("sq_lead");
const invoice = ThreadId.make("thr_invoice");
const shared = ThreadId.make("thr_shared");
const now = "2026-11-01T12:00:00.000Z";

const base = (overrides: Partial<RoomRoutingInput> = {}): RoomRoutingInput => ({
  author: { kind: "user" },
  body: "Anyone looked at this?",
  refs: [],
  replyToAuthor: null,
  quotedAuthors: [],
  members: [
    { squireId: release, name: "Release", status: "active" },
    { squireId: research, name: "Research", status: "active" },
  ],
  lead: { squireId: leadId, name: "Lead" },
  botMessagingOn: true,
  coverOf: (ref) =>
    ref.kind === "thread" && ref.threadId === invoice
      ? [release]
      : ref.kind === "thread" && ref.threadId === shared
        ? [release, research]
        : ref.kind === "pullRequest" && ref.number === 318
          ? [research]
          : [],
  recentMemberPosts: [],
  now,
  ...overrides,
});

describe("routeRoomPost", () => {
  it("(a) wakes each mentioned member and only those", () => {
    const decision = routeRoomPost(base({ body: "@Research can you check #318?" }));
    expect(decision.recipients).toEqual([research]);
    expect(decision.via).toMatchObject({ kind: "rule", rule: "mention" });
    expect(decision.jevEligible).toBe(false);
  });

  it("(a) matches names case-insensitively and wakes several mentions in member order", () => {
    const decision = routeRoomPost(base({ body: "@research and @RELEASE, sync up" }));
    expect(decision.recipients).toEqual([release, research]);
  });

  it("has no @all and never wakes the author", () => {
    const all = routeRoomPost(base({ body: "@all please look" }));
    expect(all.via).toMatchObject({ rule: "lead" });
    const self = routeRoomPost(
      base({ author: { kind: "squire", squireId: release }, body: "@Release note to self" }),
    );
    expect(self.recipients).not.toContain(release);
  });

  it("a post that only addresses the user wakes nobody", () => {
    const decision = routeRoomPost(
      base({ author: { kind: "squire", squireId: research }, body: "@you which one do you want?" }),
    );
    expect(decision.recipients).toEqual([]);
    expect(decision.via).toMatchObject({ kind: "rule", rule: "none" });
  });

  it("(b) a reply to a member's post goes to that member; a reply to the user wakes nobody", () => {
    expect(
      routeRoomPost(base({ replyToAuthor: { kind: "squire", squireId: research } })).recipients,
    ).toEqual([research]);
    const toUser = routeRoomPost(
      base({ author: { kind: "squire", squireId: release }, replyToAuthor: { kind: "user" } }),
    );
    expect(toUser.recipients).toEqual([]);
  });

  it("(b) a quote of a member's post goes to that member", () => {
    const decision = routeRoomPost(
      base({ quotedAuthors: [{ kind: "squire", squireId: release }] }),
    );
    expect(decision.recipients).toEqual([release]);
    expect(decision.via).toMatchObject({ rule: "reply" });
  });

  it("(c) refs covered by exactly one member go to it, named PRs in the body included", () => {
    expect(
      routeRoomPost(base({ refs: [{ kind: "thread", threadId: invoice }] })).recipients,
    ).toEqual([release]);
    const byPr = routeRoomPost(base({ body: "What broke in #318?" }));
    expect(byPr.recipients).toEqual([research]);
    expect(byPr.via).toMatchObject({ rule: "scope" });
  });

  it("(c) does not apply when two members cover the refs, or the refs split across members", () => {
    expect(routeRoomPost(base({ refs: [{ kind: "thread", threadId: shared }] })).via).toMatchObject(
      { rule: "lead" },
    );
    expect(
      routeRoomPost(
        base({
          body: "#318 and the invoice thread",
          refs: [{ kind: "thread", threadId: invoice }],
        }),
      ).via,
    ).toMatchObject({ rule: "lead" });
  });

  it("(d) a user post within 2 minutes of a member's post goes to that member, bot posts never", () => {
    const recent = [{ squireId: research, createdAt: "2026-11-01T11:58:30.000Z" }];
    expect(routeRoomPost(base({ recentMemberPosts: recent })).recipients).toEqual([research]);
    expect(routeRoomPost(base({ recentMemberPosts: recent })).via).toMatchObject({
      rule: "recent",
    });
    const stale = [{ squireId: research, createdAt: "2026-11-01T11:57:00.000Z" }];
    expect(routeRoomPost(base({ recentMemberPosts: stale })).via).toMatchObject({ rule: "lead" });
    const bot = routeRoomPost(
      base({ author: { kind: "squire", squireId: release }, recentMemberPosts: recent }),
    );
    expect(bot.via).toMatchObject({ rule: "lead" });
  });

  it("(e) otherwise the Lead, eligible for Jev", () => {
    const decision = routeRoomPost(base());
    expect(decision.recipients).toEqual([leadId]);
    expect(decision.via).toMatchObject({ kind: "rule", rule: "lead" });
    expect(decision.jevEligible).toBe(true);
  });

  it("(e) wakes nobody when the Lead wrote the post or there is no Lead", () => {
    expect(routeRoomPost(base({ author: { kind: "lead", squireId: leadId } })).recipients).toEqual(
      [],
    );
    expect(routeRoomPost(base({ lead: null })).recipients).toEqual([]);
  });

  it("first match wins: a mention beats the scope rule", () => {
    const decision = routeRoomPost(
      base({ body: "@Research see this", refs: [{ kind: "thread", threadId: invoice }] }),
    );
    expect(decision.recipients).toEqual([research]);
    expect(decision.via).toMatchObject({ rule: "mention" });
  });

  it("a paused match goes to the Lead with the note", () => {
    const decision = routeRoomPost(
      base({
        body: "@Research ping",
        members: [
          { squireId: release, name: "Release", status: "active" },
          { squireId: research, name: "Research", status: "paused" },
        ],
      }),
    );
    expect(decision.recipients).toEqual([leadId]);
    expect(decision.via.kind === "rule" && decision.via.match).toContain(
      "Research is paused · sent to Lead",
    );
    expect(decision.jevEligible).toBe(false);
  });

  it("bot posts route to nobody while bot messaging is off; user posts route as usual", () => {
    const bot = routeRoomPost(
      base({
        author: { kind: "squire", squireId: release },
        body: "@Research look",
        botMessagingOn: false,
      }),
    );
    expect(bot.recipients).toEqual([]);
    expect(bot.via).toMatchObject({ rule: "none" });
    const user = routeRoomPost(base({ body: "@Research look", botMessagingOn: false }));
    expect(user.recipients).toEqual([research]);
  });
});

describe("routeRoomPost edge cases", () => {
  const notes = SquireId.make("sq_release_notes");

  it("(a) matches the longest member name, spaces included, and @Lead and the Lead's name", () => {
    const members = [
      { squireId: release, name: "Release", status: "active" as const },
      { squireId: notes, name: "Release Notes", status: "active" as const },
    ];
    expect(routeRoomPost(base({ members, body: "@release notes draft it" })).recipients).toEqual([
      notes,
    ]);
    expect(routeRoomPost(base({ members, body: "@Release, notes?" })).recipients).toEqual([
      release,
    ]);
    expect(
      routeRoomPost(base({ lead: { squireId: leadId, name: "Captain" }, body: "@lead ok?" }))
        .recipients,
    ).toEqual([leadId]);
    expect(
      routeRoomPost(base({ lead: { squireId: leadId, name: "Captain" }, body: "@Captain ok?" }))
        .via,
    ).toMatchObject({ rule: "mention", match: "@Captain" });
  });

  it("(a) ignores email addresses and mentions inside quoted lines", () => {
    expect(routeRoomPost(base({ body: "mail ops@Research.dev" })).via).toMatchObject({
      rule: "lead",
    });
    const quoted = routeRoomPost(
      base({
        body: "> @Research check #318\nagreed",
        quotedAuthors: [{ kind: "squire", squireId: release }],
      }),
    );
    expect(quoted.recipients).toEqual([release]);
    expect(quoted.via).toMatchObject({ rule: "reply", match: "quote of Release" });
  });

  it("a mix of active and paused matches wakes the active ones plus the Lead, once", () => {
    const decision = routeRoomPost(
      base({
        body: "@Research @Release @Lead",
        members: [
          { squireId: release, name: "Release", status: "active" },
          { squireId: research, name: "Research", status: "paused" },
        ],
      }),
    );
    expect(decision.recipients).toEqual([release, leadId]);
    expect(decision.via.kind === "rule" && decision.via.match).toContain(
      "Research is paused · sent to Lead",
    );
  });

  it("(b) a reply to the Lead goes to the Lead; (d) a paused recent member goes to the Lead", () => {
    const reply = routeRoomPost(base({ replyToAuthor: { kind: "lead", squireId: leadId } }));
    expect(reply.recipients).toEqual([leadId]);
    expect(reply.via).toMatchObject({ rule: "reply", match: "reply to Lead" });
    const recent = routeRoomPost(
      base({
        members: [{ squireId: research, name: "Research", status: "paused" }],
        recentMemberPosts: [{ squireId: research, createdAt: "2026-11-01T11:59:00.000Z" }],
      }),
    );
    expect(recent.recipients).toEqual([leadId]);
    expect(recent.via).toMatchObject({ rule: "recent" });
    expect(recent.jevEligible).toBe(false);
  });

  it("chip text names the match", () => {
    expect(routeRoomPost(base({ body: "What broke in #318?" })).via).toMatchObject({
      match: "named PR #318",
    });
    expect(
      routeRoomPost(
        base({
          recentMemberPosts: [{ squireId: research, createdAt: "2026-11-01T11:59:00.000Z" }],
        }),
      ).via,
    ).toMatchObject({ match: "within 2 min of Research" });
  });
});

describe("quotedLines", () => {
  it("returns each quoted line's text", () => {
    expect(quotedLines("> the build is red\nwhy?\n>  second")).toEqual([
      "the build is red",
      "second",
    ]);
    expect(quotedLines("a\r\n> > nested\r\n>\r\nb")).toEqual(["nested"]);
  });
});
