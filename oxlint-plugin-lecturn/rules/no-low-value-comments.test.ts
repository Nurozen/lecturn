import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("lecturn/no-low-value-comments", {
  filename: "fixture.ts",
});

describe("lecturn/no-low-value-comments", () => {
  rule.valid(
    "allows a comment that explains why",
    `
      // The socket closes on idle, so the retry has to reconnect first.
      export const retryDelayMs = 250;
    `,
  );

  rule.valid(
    "allows lint directives and linked task markers",
    `
      // TODO(#123): drop once the host reports its version.
      // oxlint-disable-next-line eslint/no-console -- startup diagnostics
      console.log("ready");
    `,
  );

  rule.invalid(
    "reports a section divider",
    `
      // ----- helpers -----
      export const value = 1;
    `,
    (output) => {
      assert.match(output, /Drop the section divider/);
    },
  );

  rule.invalid(
    "reports a comment that restates the next name",
    `
      // Get the user name
      export function getUserName() {
        return "";
      }
    `,
    (output) => {
      assert.match(output, /only repeats the name below it/);
    },
  );

  rule.invalid(
    "reports an unlinked task marker",
    `
      // TODO: handle this later
      export const value = 1;
    `,
    (output) => {
      assert.match(output, /Link the issue/);
    },
  );

  rule.invalid(
    "reports commented-out code",
    `
      // const legacy = compute();
      export const value = 1;
    `,
    (output) => {
      assert.match(output, /Delete commented-out code/);
    },
  );
});
