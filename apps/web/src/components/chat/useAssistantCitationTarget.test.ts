import { describe, expect, it } from "vite-plus/test";
import { citationSourceReadiness } from "./useAssistantCitationTarget";

describe("citation source preparation", () => {
  it("waits for the user expansion to commit before allowing a measured navigation target", () => {
    const mountedUser = { role: "user", userExpanded: false, rowPresent: true, listReady: true };
    expect(citationSourceReadiness(mountedUser)).toBe("expand-user");
    // Requesting expansion is insufficient: until the new render commits, a
    // second reconciliation must still not release the navigation target.
    expect(citationSourceReadiness(mountedUser)).toBe("expand-user");
    expect(citationSourceReadiness({ ...mountedUser, userExpanded: true })).toBe("ready");
  });

  it("expands, unfolds, and awaits list measurement in that order", () => {
    const source = { role: "user", userExpanded: false, rowPresent: false, listReady: false };
    expect(citationSourceReadiness(source)).toBe("expand-user");
    expect(citationSourceReadiness({ ...source, userExpanded: true })).toBe("expand-turn");
    expect(citationSourceReadiness({ ...source, userExpanded: true, rowPresent: true })).toBe(
      "wait",
    );
    expect(
      citationSourceReadiness({ ...source, userExpanded: true, rowPresent: true, listReady: true }),
    ).toBe("ready");
  });

  it("leaves assistant citations independent of user-body expansion", () => {
    const source = { role: "assistant", userExpanded: false, rowPresent: true, listReady: true };
    expect(citationSourceReadiness(source)).toBe("ready");
    expect(citationSourceReadiness({ ...source, rowPresent: false })).toBe("expand-turn");
    expect(citationSourceReadiness({ ...source, listReady: false })).toBe("wait");
  });

  it.each(["system", "tool", "unknown"])(
    "does not pin an unsupported %s message forever",
    (role) => {
      expect(
        citationSourceReadiness({ role, userExpanded: false, rowPresent: true, listReady: true }),
      ).toBe("unsupported");
    },
  );
});
