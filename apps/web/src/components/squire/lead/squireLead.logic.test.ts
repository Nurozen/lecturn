import type {
  EnvironmentId,
  SquireCard,
  SquireCardId,
  SquireCardKind,
  SquireCardStatus,
  SquireId,
} from "@lecturn/contracts";
import {
  DEFAULT_SQUIRE_COMPANION,
  DEFAULT_SQUIRE_PERMISSIONS,
  SquireCardPayload,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  createSquireLeadGreets,
  createSquireLeadOnboardingRuns,
  squireLeadBadgeTooltip,
  squireLeadGreeting,
  squireLeadOnboardingPhase,
  squireLeadProposalPayload,
  squireLeadProposalRows,
  squireProposalPaletteLabel,
  squireProposalPortrait,
  squireRowsOutsideOnboarding,
} from "./squireLead.logic";

const ENV = "env-1" as EnvironmentId;
const LEAD = "lead" as SquireId;
const RELEASE = "release" as SquireId;

const decodePayload = Schema.decodeUnknownSync(SquireCardPayload);

const proposalPayload = {
  type: "squire-proposal",
  name: "Release",
  brief: "Watch release PRs.",
  grants: [{ kind: "project", targetId: "billing" }],
  permissions: DEFAULT_SQUIRE_PERMISSIONS,
  companion: DEFAULT_SQUIRE_COMPANION,
} as const;

function card(
  overrides: {
    readonly kind?: SquireCardKind;
    readonly status?: SquireCardStatus;
    readonly squireId?: SquireId;
    readonly payload?: unknown;
  } = {},
) {
  return {
    kind: overrides.kind ?? "proposal",
    status: overrides.status ?? "open",
    squireId: overrides.squireId ?? LEAD,
    payload: (overrides.payload ?? proposalPayload) as SquireCard["payload"],
  };
}

describe("onboarding proposals", () => {
  it("are open proposals the Lead raised with a Squire proposal payload", () => {
    expect(squireLeadProposalPayload(card(), LEAD)).toBe(proposalPayload);
  });

  it("leave out other Squires' proposals, settled cards, and other kinds", () => {
    expect(squireLeadProposalPayload(card({ squireId: RELEASE }), LEAD)).toBeNull();
    expect(squireLeadProposalPayload(card({ status: "dismissed" }), LEAD)).toBeNull();
    expect(squireLeadProposalPayload(card({ status: "held" }), LEAD)).toBeNull();
    expect(squireLeadProposalPayload(card({ kind: "overlap" }), LEAD)).toBeNull();
  });

  it("leave out the Lead's thread and room proposals", () => {
    const thread = { type: "thread-proposal", projectId: "p", firstPrompt: "Go" };
    expect(squireLeadProposalPayload(card({ payload: thread }), LEAD)).toBeNull();
    const room = { type: "room-proposal", topic: "Sync" };
    expect(squireLeadProposalPayload(card({ payload: room }), LEAD)).toBeNull();
  });

  it("load details only for the Lead's own open proposal rows", () => {
    const rows = [
      { id: "a", ...card() },
      { id: "b", ...card({ squireId: RELEASE }) },
      { id: "c", ...card({ kind: "steer" }) },
      { id: "d", ...card({ status: "accepting" }) },
    ];
    expect(squireLeadProposalRows(rows, LEAD).map((row) => row.id)).toEqual(["a"]);
  });
});

describe("proposal portraits", () => {
  // The companions fixture 00 proposes, as the server stores them: only the keys the Lead chose.
  const proposed = [
    { name: "Steward", appearance: "male", hood: "up", equipment: "grimoire", palette: "rose" },
    { name: "Research", appearance: "female", hood: "up", equipment: "astrolabe", palette: "sage" },
    {
      name: "Release",
      appearance: "male",
      hood: "down",
      equipment: "helmet",
      palette: "moonstone",
    },
  ] as const;

  it("draw each decoded proposal's own figure and equipment, always still", () => {
    const portraits = proposed.map(({ name, ...companion }) => {
      const payload = decodePayload({
        ...proposalPayload,
        name,
        companion: { presence: "figure", motion: "lively", ...companion },
      });
      const decoded = squireLeadProposalPayload(card({ payload }), LEAD);
      return decoded === null ? null : squireProposalPortrait(decoded.companion);
    });
    expect(portraits).toEqual(
      proposed.map(({ appearance, hood, equipment, palette }) =>
        expect.objectContaining({
          presence: "figure",
          appearance,
          hood,
          equipment,
          palette,
          motion: "still",
        }),
      ),
    );
    const keys = portraits.map((portrait) =>
      portrait === null ? null : `${portrait.appearance}/${portrait.hood}/${portrait.palette}`,
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(
      `${DEFAULT_SQUIRE_COMPANION.appearance}/${DEFAULT_SQUIRE_COMPANION.hood}/${DEFAULT_SQUIRE_COMPANION.palette}`,
    );
  });

  it("name each proposal's palette beside its swatch, distinct for distinct palettes", () => {
    const labels = proposed.map(({ name, ...companion }) => {
      const decoded = squireLeadProposalPayload(
        card({
          payload: decodePayload({
            ...proposalPayload,
            name,
            companion: { presence: "figure", ...companion },
          }),
        }),
        LEAD,
      );
      return decoded === null ? null : squireProposalPaletteLabel(decoded.companion.palette);
    });
    expect(labels).toEqual(["Rose", "Sage", "Moonstone"]);
    expect(squireProposalPaletteLabel(DEFAULT_SQUIRE_COMPANION.palette)).toBe("Brass");
  });

  it("keep an emblem proposal's frame, weight, and glow", () => {
    const payload = decodePayload({
      ...proposalPayload,
      companion: { presence: "emblem", palette: "sage", frame: "seal", weight: "bold" },
    });
    const decoded = squireLeadProposalPayload(card({ payload }), LEAD);
    expect(decoded === null ? null : squireProposalPortrait(decoded.companion)).toEqual(
      expect.objectContaining({
        presence: "emblem",
        palette: "sage",
        frame: "seal",
        weight: "bold",
        motion: "still",
      }),
    );
  });
});

describe("onboarding visibility", () => {
  const lead = {
    onboardedAt: "2026-11-01T10:00:00.000Z",
    lifecycle: "ready",
    status: "active",
  } as const;

  it("shows proposals whenever the Lead has some open", () => {
    expect(squireLeadOnboardingPhase({ lead, proposalCount: 2, run: null })).toBe("proposals");
    expect(
      squireLeadOnboardingPhase({
        lead: { ...lead, status: "paused" },
        proposalCount: 1,
        run: null,
      }),
    ).toBe("proposals");
  });

  it("looks before the first open is recorded and while a queued onboarding runs", () => {
    expect(
      squireLeadOnboardingPhase({
        lead: { ...lead, onboardedAt: null },
        proposalCount: 0,
        run: null,
      }),
    ).toBe("looking");
    expect(squireLeadOnboardingPhase({ lead, proposalCount: 0, run: { sawWorking: true } })).toBe(
      "looking",
    );
  });

  it("hides once onboarded with nothing open, or when the Lead cannot run", () => {
    expect(squireLeadOnboardingPhase({ lead, proposalCount: 0, run: null })).toBe("hidden");
    expect(
      squireLeadOnboardingPhase({
        lead: { ...lead, onboardedAt: null, lifecycle: "needs_provider" },
        proposalCount: 0,
        run: null,
      }),
    ).toBe("hidden");
    expect(
      squireLeadOnboardingPhase({
        lead: { ...lead, onboardedAt: null, status: "paused" },
        proposalCount: 0,
        run: null,
      }),
    ).toBe("hidden");
  });

  it("ends a queued run only after the Lead was seen working and then stopped", () => {
    const runs = createSquireLeadOnboardingRuns();
    let changes = 0;
    runs.subscribe(() => changes++);
    runs.observe(ENV, false);
    expect(runs.get(ENV)).toBeNull();
    runs.queued(ENV);
    runs.observe(ENV, false);
    expect(runs.get(ENV)).toEqual({ sawWorking: false });
    runs.observe(ENV, true);
    runs.observe(ENV, true);
    expect(runs.get(ENV)).toEqual({ sawWorking: true });
    runs.observe(ENV, false);
    expect(runs.get(ENV)).toBeNull();
    expect(changes).toBe(3);
  });
});

describe("Lead queue beside onboarding", () => {
  const rows = ["p1", "p2", "overlap"].map((id) => ({ id: id as SquireCardId }));

  it("leaves out the proposals the onboarding panel shows as cards", () => {
    expect(squireRowsOutsideOnboarding(rows, new Set(["p1", "p2"]))).toEqual([rows[2]]);
  });

  it("keeps every row once the onboarding shows nothing", () => {
    expect(squireRowsOutsideOnboarding(rows, new Set())).toBe(rows);
  });
});

describe("Lead greet on proposals", () => {
  it("greets once when the first proposal set appears", () => {
    const greets = createSquireLeadGreets();
    expect(greets.claim(LEAD, [])).toBe(false);
    expect(greets.claim(LEAD, ["p1", "p2", "p3"])).toBe(true);
    expect(greets.claim(LEAD, ["p1", "p2", "p3"])).toBe(false);
  });

  it("does not greet again as cards of the same onboarding are accepted or skipped", () => {
    const greets = createSquireLeadGreets();
    greets.claim(LEAD, ["p1", "p2", "p3"]);
    expect(greets.claim(LEAD, ["p2", "p3"])).toBe(false);
    expect(greets.claim(LEAD, ["p3", "p4"])).toBe(false);
  });

  it("greets a later onboarding with no card in common, and each Lead apart", () => {
    const greets = createSquireLeadGreets();
    greets.claim(LEAD, ["p1"]);
    expect(greets.claim(LEAD, ["p9"])).toBe(true);
    expect(greets.claim("other-lead" as SquireId, ["p1"])).toBe(true);
  });
});

describe("Lead greeting line", () => {
  it("speaks as the Lead while looking and once proposals are shown", () => {
    expect(squireLeadGreeting("Lead", "looking", 0)).toBe(
      "Hi, I'm your Lead. I'm looking at your projects…",
    );
    expect(squireLeadGreeting("Lead", "proposals", 3)).toBe(
      "Hi, I'm your Lead. I looked at your projects and suggest these Squires.",
    );
    expect(squireLeadGreeting("Lead", "proposals", 1)).toBe(
      "Hi, I'm your Lead. I looked at your projects and suggest this Squire.",
    );
  });

  it("uses the Lead's own name once renamed", () => {
    expect(squireLeadGreeting(" Marshal ", "proposals", 2)).toBe(
      "Hi, I'm Marshal, your Lead. I looked at your projects and suggest these Squires.",
    );
    expect(squireLeadGreeting("Marshal", "looking", 0)).toBe(
      "Hi, I'm Marshal, your Lead. I'm looking at your projects…",
    );
    expect(squireLeadGreeting("lead", "looking", 0)).toBe(
      "Hi, I'm your Lead. I'm looking at your projects…",
    );
  });
});

describe("Lead badge tooltip", () => {
  const counted = (name: string, openDecisionCount: number) => ({
    squire: { name },
    openDecisionCount,
  });

  it("splits the Lead's own items from its Squires'", () => {
    expect(
      squireLeadBadgeTooltip({
        lead: counted("Lead", 1),
        squires: [counted("Release", 1), counted("Research", 1), counted("Docs", 0)],
      }),
    ).toBe("1 raised by Lead · 2 by your Squires");
  });

  it("names the one Squire with items", () => {
    expect(
      squireLeadBadgeTooltip({
        lead: counted("Lead", 1),
        squires: [counted("Release", 2), counted("Research", 0)],
      }),
    ).toBe("1 raised by Lead · 2 by Release");
    expect(
      squireLeadBadgeTooltip({ lead: counted("Lead", 0), squires: [counted("Release", 3)] }),
    ).toBe("3 raised by Release");
  });

  it("says only what is there", () => {
    expect(
      squireLeadBadgeTooltip({ lead: counted("Lead", 2), squires: [counted("Release", 0)] }),
    ).toBe("2 raised by Lead");
    expect(squireLeadBadgeTooltip({ lead: counted("Lead", 0), squires: [] })).toBeNull();
  });
});
