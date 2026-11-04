import { assert, describe, it } from "@effect/vitest";
import { ProjectId, SquireId, ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { squireInstructionsTurnInput, squireSkillSections } from "./skill/skill.ts";
import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const roles = ["squire", "lead"] as const;

describe("Squire skill text", () => {
  it.each(roles)("keeps every %s section whole under Codex's entry cap", (role) => {
    const sections = squireSkillSections(role);
    assert.isAbove(sections.length, 1);
    for (const section of sections) {
      assert.isAtMost(bytes(section), CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES);
      assert.match(section, /^#{2,3} /, "each section opens with its own heading");
    }
  });

  it.each(roles)("names only %s tools that exist or are marked as later", (role) => {
    // A tool the skill tells the model to call must be on the role's list,
    // or sit in the section that says it applies once its tool exists.
    const sections = squireSkillSections(role);
    const known = new Set<string>(SQUIRE_TOOL_NAMES[role]);
    for (const section of sections) {
      const later = section.includes("apply once their events and tools exist");
      for (const [name] of section.matchAll(/(?:squire|html)_[a-z_]+/g)) {
        if (!later) assert.isTrue(known.has(name), `${role} skill names unknown tool ${name}`);
      }
    }
  });

  it.each(roles)("tells a %s its pages are self-contained and locked down", (role) => {
    const text = squireSkillSections(role).join("\n\n");
    for (const phrase of ["`html_render`", "self-contained", "Local file paths are refused"]) {
      assert.include(text, phrase);
    }
  });

  it("covers the Squire behaviors the bar judges", () => {
    const text = squireSkillSections("squire").join("\n\n");
    for (const phrase of [
      "Stay quiet by default",
      "Under 280 characters",
      "Quote the evidence",
      "Notify only",
      "watches its own pull request",
      "only way to act",
      "No approval prompt will ever come",
      "`replyTo`",
    ]) {
      assert.include(text, phrase);
    }
  });
});

const now = "2026-11-01T00:00:00.000Z";
const leadId = SquireId.make("squire-lead");
const releaseId = SquireId.make("squire-release");

const row = (id: SquireId, role: "lead" | "squire"): SquireRepository.SquireRow => ({
  id,
  role,
  name: role === "lead" ? "Lead" : "Release",
  lifecycle: "ready",
  home_generation: 0,
  home_thread_id: ThreadId.make(`home-${id}`),
  home_project_id: ProjectId.make("project-1"),
  provider_instance_id: "codex",
  model_selection_json: "{}",
  summary_model_selection_json: null,
  brief: "",
  status: "active",
  events_json: "{}",
  permissions_json: "{}",
  budgets_json: "{}",
  undo_window_seconds: 10,
  digest_json: null,
  digest_last_date: null,
  onboarded_at: null,
  sweep_json: null,
  user_active_at: null,
  inactivity_prompted_at: null,
  automation_paused_at: null,
  companion_json: "{}",
  revision: 0,
  create_request_id: null,
  created_at: now,
  updated_at: now,
});

describe("squireInstructionsTurnInput", () => {
  it.layer(Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory))(
    "with a repository",
    (it) => {
      it.effect("gives a home its role's skill, and probes and user threads none", () =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* repository.createSquire(row(leadId, "lead"));
          yield* repository.createSquire(row(releaseId, "squire"));

          assert.deepEqual(
            yield* squireInstructionsTurnInput({ squire: { squireId: leadId, role: "home" } }),
            { squireInstructions: squireSkillSections("lead") },
          );
          assert.deepEqual(
            yield* squireInstructionsTurnInput({ squire: { squireId: releaseId, role: "home" } }),
            { squireInstructions: squireSkillSections("squire") },
          );
          // A record gone mid-delete reads as the narrower role.
          assert.deepEqual(
            yield* squireInstructionsTurnInput({
              squire: { squireId: SquireId.make("squire-gone"), role: "home" },
            }),
            { squireInstructions: squireSkillSections("squire") },
          );
          assert.deepEqual(
            yield* squireInstructionsTurnInput({ squire: { squireId: leadId, role: "probe" } }),
            {},
          );
          assert.deepEqual(yield* squireInstructionsTurnInput({}), {});
        }),
      );
    },
  );
});
