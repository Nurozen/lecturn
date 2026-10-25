import type { AppRuntimeCeiling, ProviderInteractionMode, RuntimeMode } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  type AppToolGateDecision,
  type AppToolGateInput,
  credentialRuntimeModeCeiling,
  decide,
  READ_ONLY_REFUSAL,
} from "./AppToolGate.ts";

const FORWARD_APPROVED = { kind: "forward", approved: true } as const;
const FORWARD_UNAPPROVED = { kind: "forward", approved: false } as const;
const ASK = { kind: "ask" } as const;
const REFUSE = { kind: "refuse", reason: READ_ONLY_REFUSAL } as const;

const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

type Call = "ungated" | "static gated" | "app-decided";

const call = (kind: Call): Pick<AppToolGateInput, "stage" | "gated"> =>
  kind === "ungated"
    ? { stage: "static", gated: false }
    : kind === "static gated"
      ? { stage: "static", gated: true }
      : { stage: "app", gated: false };

/** Each runtime mode's answer for each kind of call, in default interaction mode and with no ceiling. */
const EXPECTED: Readonly<Record<RuntimeMode, Readonly<Record<Call, AppToolGateDecision>>>> = {
  "approval-required": {
    ungated: FORWARD_UNAPPROVED,
    "static gated": ASK,
    "app-decided": ASK,
  },
  "auto-accept-edits": {
    ungated: FORWARD_UNAPPROVED,
    "static gated": ASK,
    "app-decided": ASK,
  },
  auto: {
    ungated: FORWARD_APPROVED,
    "static gated": FORWARD_APPROVED,
    "app-decided": FORWARD_APPROVED,
  },
  "full-access": {
    ungated: FORWARD_APPROVED,
    "static gated": FORWARD_APPROVED,
    "app-decided": FORWARD_APPROVED,
  },
};

const CALLS = ["ungated", "static gated", "app-decided"] as const satisfies ReadonlyArray<Call>;

const gate = (
  runtimeMode: RuntimeMode,
  kind: Call,
  options: { interactionMode?: ProviderInteractionMode; ceiling?: AppRuntimeCeiling } = {},
) =>
  decide({
    ...call(kind),
    runtimeMode,
    interactionMode: options.interactionMode ?? "default",
    ceiling: options.ceiling ?? null,
  });

describe("AppToolGate.decide", () => {
  describe.each(RUNTIME_MODES)("runtime mode %s", (runtimeMode) => {
    it.each(CALLS)("%s call", (kind) => {
      expect(gate(runtimeMode, kind)).toEqual(EXPECTED[runtimeMode][kind]);
    });

    it.each(CALLS)("%s call in Plan follows the runtime mode", (kind) => {
      expect(gate(runtimeMode, kind, { interactionMode: "plan" })).toEqual(
        EXPECTED[runtimeMode][kind],
      );
    });

    it("a read-only ceiling refuses gated and app-decided calls and runs ungated ones", () => {
      for (const interactionMode of ["default", "plan"] as const) {
        expect(gate(runtimeMode, "ungated", { interactionMode, ceiling: "read-only" })).toEqual(
          FORWARD_UNAPPROVED,
        );
        expect(
          gate(runtimeMode, "static gated", { interactionMode, ceiling: "read-only" }),
        ).toEqual(REFUSE);
        expect(gate(runtimeMode, "app-decided", { interactionMode, ceiling: "read-only" })).toEqual(
          REFUSE,
        );
      }
    });
  });

  it("a ceiling caps the thread's mode and never raises it", () => {
    expect(gate("full-access", "static gated", { ceiling: "approval-required" })).toEqual(ASK);
    expect(gate("auto", "app-decided", { ceiling: "auto-accept-edits" })).toEqual(ASK);
    expect(gate("full-access", "static gated", { ceiling: "auto" })).toEqual(FORWARD_APPROVED);
    expect(gate("approval-required", "static gated", { ceiling: "full-access" })).toEqual(ASK);
  });

  it("fails closed on a mode it does not know", () => {
    const unknown = <T>(value: string) => value as T;
    for (const kind of ["static gated", "app-decided"] as const) {
      expect(gate(unknown<RuntimeMode>("yolo"), kind)).toEqual(REFUSE);
      expect(
        gate("full-access", kind, { interactionMode: unknown<ProviderInteractionMode>("swarm") }),
      ).toEqual(REFUSE);
      expect(
        gate("full-access", kind, { ceiling: unknown<AppRuntimeCeiling>("sandboxed") }),
      ).toEqual(REFUSE);
    }
    expect(gate(unknown<RuntimeMode>("yolo"), "ungated")).toEqual(FORWARD_UNAPPROVED);
  });
});

describe("AppToolGate.credentialRuntimeModeCeiling", () => {
  it("never puts a read-only ceiling in the rtc claim", () => {
    expect(credentialRuntimeModeCeiling("read-only")).toBeUndefined();
    expect(credentialRuntimeModeCeiling(null)).toBeUndefined();
  });

  it.each(RUNTIME_MODES)("maps the %s ceiling to the claim as is", (mode) => {
    expect(credentialRuntimeModeCeiling(mode)).toBe(mode);
  });
});
