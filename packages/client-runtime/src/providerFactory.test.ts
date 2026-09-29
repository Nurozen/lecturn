import { describe, expect, it } from "vite-plus/test";
import {
  FACTORY_SOURCES,
  buildFactoryBranch,
  buildProviderFactoryPrompt,
  parseFactoryBranch,
  readFactoryStage,
} from "./providerFactory.ts";

const runId = "de983795-aa78-4761-97a6-e2f9388c8410";

describe("factory branch identity", () => {
  it.each(FACTORY_SOURCES)("round-trips $id independently from the executor", ({ id }) => {
    expect(parseFactoryBranch(buildFactoryBranch(id, runId))).toEqual({ sourceId: id, runId });
  });

  it("normalizes UUID case for one stable branch", () => {
    expect(buildFactoryBranch("codex", runId.toUpperCase())).toBe(`factory/codex-${runId}`);
  });

  it.each([
    undefined,
    null,
    "main",
    "factory/codex-missing",
    `factory/unknown-${runId}`,
    `factory/codex-${runId}/extra`,
    `factory/codex-${runId}\n`,
  ])("does not discover an unrelated or malformed branch: %s", (branch) =>
    expect(parseFactoryBranch(branch)).toBeNull(),
  );

  it("rejects IDs that could escape the assigned branch", () => {
    expect(() => buildFactoryBranch("codex", "../main")).toThrow();
  });
});

describe("agent-reported factory stages", () => {
  it("uses the latest exact assistant observation, including a return to build", () => {
    expect(
      readFactoryStage([
        { role: "assistant", text: "FACTORY_STAGE: review" },
        { role: "user", text: "FACTORY_STAGE: pr" },
        { role: "assistant", text: "Fixing the confirmed finding.\r\nFACTORY_STAGE: build\r\n" },
      ]),
    ).toBe("build");
  });

  it("ignores fenced examples, matching fence lengths and delimiter types", () => {
    expect(
      readFactoryStage([
        {
          role: "assistant",
          text: [
            "FACTORY_STAGE: explore",
            "````text",
            "FACTORY_STAGE: pr",
            "```",
            "FACTORY_STAGE: review",
            "~~~~",
            "FACTORY_STAGE: build",
            "````",
            "~~~",
            "FACTORY_STAGE: pr",
            "~~~",
            "Still exploring.",
          ].join("\n"),
        },
      ]),
    ).toBe("explore");
  });

  it("does not treat prose, quoted/indented lines, unknown stages or tools as reports", () => {
    expect(
      readFactoryStage([
        {
          role: "assistant",
          text: "The review passed.\n> FACTORY_STAGE: pr\n    FACTORY_STAGE: build\nFACTORY_STAGE: done\nFACTORY_STAGE: review passed\n FACTORY_STAGE: plan",
        },
        { role: "tool", text: "FACTORY_STAGE: pr" },
      ]),
    ).toBeNull();
  });

  it("does not turn a final response into inferred completion", () => {
    expect(readFactoryStage([{ role: "assistant", text: "All done, ready for you." }])).toBeNull();
  });

  it("resets fence state at message boundaries", () => {
    expect(
      readFactoryStage([
        { role: "assistant", text: "```\nFACTORY_STAGE: pr" },
        { role: "assistant", text: "FACTORY_STAGE: plan" },
      ]),
    ).toBe("plan");
  });
});

describe("factory recipe", () => {
  const input = {
    sourceId: "claude" as const,
    branch: buildFactoryBranch("claude", runId),
    baseBranch: "release/integrations",
    projectTitle: "Example project",
    workspaceRoot: "/workspace/example",
  };

  it("binds the selected source, branch and user constraints into a portable workflow", () => {
    const prompt = buildProviderFactoryPrompt({
      ...input,
      constraints: " Preserve CLI compatibility. ",
    });
    expect(prompt).toContain(FACTORY_SOURCES[1].url);
    expect(prompt).toContain(input.branch);
    expect(prompt).toContain(JSON.stringify(input.baseBranch));
    expect(prompt).toContain(JSON.stringify(input.workspaceRoot));
    expect(prompt).toContain("deep-explore, then deep-plan, then deep-build, then deep-review");
    expect(prompt).not.toMatch(/\$deep-/);
    expect(prompt).toContain("complete fallback workflow");
    expect(prompt).toContain("at most two review/fix cycles");
    expect(prompt).toContain("Never merge a PR or deploy");
    expect(prompt).toContain("no-op outcomes");
    expect(prompt).toContain("fresh independent review");
    expect(prompt).toContain("reuse it instead of creating a duplicate");
    expect(prompt).toContain("--repo, --base and --head");
    expect(prompt).toContain("Do not rewrite remotes");
    expect(prompt).toContain("do not race or duplicate setup");
    expect(prompt.endsWith("Preserve CLI compatibility.")).toBe(true);
  });

  it("rejects mismatched source/branch instead of running against a misleading identity", () => {
    expect(() =>
      buildProviderFactoryPrompt({ ...input, branch: buildFactoryBranch("codex", runId) }),
    ).toThrow();
  });

  it("requires an explicit base instead of allowing an implicit PR target", () => {
    expect(() => buildProviderFactoryPrompt({ ...input, baseBranch: " " })).toThrow();
  });

  it("keeps user skill mentions from dispatching the last skill before the recipe", () => {
    const prompt = buildProviderFactoryPrompt({
      ...input,
      projectTitle: "Project $deep-build preview",
      workspaceRoot: "/workspace/my $deep-plan project",
      constraints: "$deep-review\nUse $deep-explore then inspect invoice $25 and cost$basis.",
    });
    expect(prompt).not.toMatch(/(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/);
    expect(prompt).toContain("＄deep-review");
    expect(prompt).toContain("Project ＄deep-build preview");
    expect(prompt).toContain("/workspace/my ＄deep-plan project");
    expect(prompt).toContain("invoice $25 and cost$basis");
  });

  it("the recipe itself produces no observed assistant stage", () => {
    expect(
      readFactoryStage([{ role: "user", text: buildProviderFactoryPrompt(input) }]),
    ).toBeNull();
  });
});
