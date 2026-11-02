import { describe, expect, it } from "vite-plus/test";

import { squireComposerPlaceholder } from "./composerPlaceholder";

describe("squireComposerPlaceholder", () => {
  it("names a Squire, gives the Lead its routing prompt, and leaves other threads alone", () => {
    expect(squireComposerPlaceholder({ name: "Release", role: "squire" })).toBe(
      "Ask Release about anything it watches…",
    );
    expect(squireComposerPlaceholder({ name: "Lead", role: "lead" })).toBe(
      "Ask the Lead to route a task or check on your Squires…",
    );
    expect(squireComposerPlaceholder(null)).toBeNull();
  });
});
