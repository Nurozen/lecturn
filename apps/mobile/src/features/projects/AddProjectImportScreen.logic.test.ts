import { ProviderDriverKind, ProviderInstanceId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkImportFailureDetails,
  folderProviderCountsLabel,
} from "./AddProjectImportScreen.logic";

describe("folderProviderCountsLabel", () => {
  it("names each instance with its count and falls back to the driver kind", () => {
    const claude = ProviderInstanceId.make("claude-work");
    const codex = ProviderInstanceId.make("codex");
    expect(
      folderProviderCountsLabel(
        [
          {
            providerInstanceId: claude,
            driverKind: ProviderDriverKind.make("claudeAgent"),
            count: 4,
          },
          { providerInstanceId: codex, driverKind: ProviderDriverKind.make("codex"), count: 2 },
        ],
        new Map([[claude, "Claude Code"]]),
      ),
    ).toBe("Claude Code (4) · codex (2)");
  });
});

describe("bulkImportFailureDetails", () => {
  it("leads with the summary and lists each failed session", () => {
    expect(
      bulkImportFailureDetails("2 sessions could not be imported.", [
        { title: "Fix login", message: "That session no longer exists." },
        { title: "Refactor", message: "That session could not be read." },
      ]),
    ).toBe(
      "2 sessions could not be imported.\n\nFix login: That session no longer exists.\n\nRefactor: That session could not be read.",
    );
  });
});
