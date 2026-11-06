import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  SquireId,
  SquireTriggerId,
  type SquireTrigger,
  type SquireWebhookSecret,
} from "@lecturn/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";

const commands = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  test: vi.fn(),
  update: vi.fn(),
  resume: vi.fn(),
}));

vi.mock(import("../../../state/squires"), async (original) => {
  const actual = await original();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const allowed = A.make(true);
  const triggers = A.make(R.success({ triggers: [] as Array<SquireTrigger> }));
  const runs = A.make(R.success({ runs: [] }));
  const command = (key: string) => ({ key, permissionAtom: () => allowed });
  return {
    ...actual,
    useSquireEnvironmentState: (() => null) as never,
    squireEnvironment: {
      ...actual.squireEnvironment,
      triggers: (() => triggers) as never,
      triggerRuns: (() => runs) as never,
      triggerCreate: command("create"),
      triggerUpdate: command("update"),
      triggerRotate: command("rotate"),
      triggerRevoke: command("revoke"),
      triggerTest: command("test"),
      automationResume: command("resume"),
    } as never,
  };
});
vi.mock(import("../../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((atom: { key: keyof typeof commands }) => commands[atom.key]) as never,
}));
vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "https://box.example.ts.net",
}));
vi.mock(import("../../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: async () => true,
}));

import { squireEnvironment } from "../../../state/squires";
import { SquireTriggersSection } from "./SquireTriggersSection";

const environmentId = EnvironmentId.make("remote-box");
const squireId = SquireId.make("squire-release");
const hookId = SquireTriggerId.make("trigger-hook");
const triggersAtom = squireEnvironment.triggers({
  environmentId,
  input: { squireId },
}) as unknown as Atom.Writable<AsyncResult.AsyncResult<{ triggers: Array<SquireTrigger> }>>;

function trigger(overrides: Partial<SquireTrigger>): SquireTrigger {
  return {
    id: hookId,
    squireId,
    name: "When Sentry reports a new error in billing-service",
    kind: "webhook",
    instruction: "Triage the error and raise a decision",
    status: "active",
    schedule: null,
    nextSlotAt: null,
    secretGeneration: 1,
    limitedUntil: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    ...overrides,
  };
}

let registry: AtomRegistry.AtomRegistry;
let listed: Array<SquireTrigger>;

function setTriggers(next: Array<SquireTrigger>) {
  listed = next;
  registry.set(triggersAtom, AsyncResult.success({ triggers: next }));
}

// Mounts the section on a fresh registry; disposing unmounts it and drops the registry.
async function setup(): Promise<AsyncDisposable> {
  registry = AtomRegistry.make();
  listed = [];
  for (const fn of Object.values(commands)) fn.mockReset();
  commands.create.mockImplementation(async ({ input }) => {
    const created = trigger({ name: input.name, instruction: input.instruction });
    // The server's list refresh lands the row; the secret only ever arrives on this result.
    setTriggers([...listed, created]);
    const webhook: SquireWebhookSecret = {
      secret: "whsec_first",
      path: `/api/squire/hooks/${hookId}`,
    };
    return { _tag: "Success", value: { trigger: created, webhook } };
  });
  commands.rotate.mockImplementation(async () => ({
    _tag: "Success",
    value: {
      trigger: trigger({ secretGeneration: 2 }),
      webhook: { secret: "whsec_rotated", path: `/api/squire/hooks/${hookId}` },
    },
  }));
  commands.test.mockResolvedValue({ _tag: "Success", value: { outcome: "queued", retryAt: null } });
  setTriggers([]);
  const current = registry;
  const screen = await render(
    <RegistryContext.Provider value={current}>
      <SquireTriggersSection
        environmentId={environmentId}
        squire={{ id: squireId, name: "Release", role: "squire" }}
      />
    </RegistryContext.Provider>,
  ).catch((error: unknown) => {
    current.dispose();
    throw error;
  });
  return {
    async [Symbol.asyncDispose]() {
      try {
        await screen[Symbol.asyncDispose]();
      } finally {
        current.dispose();
      }
    },
  };
}

// No app CSS loads here, so the dialog's unstyled popup sits under its own inert backdrop and
// a pointer click cannot reach Done; press it the way a keyboard user would.
const closeDialog = () =>
  act(async () =>
    (
      page.getByRole("dialog").getByRole("button", { name: "Done" }).element() as HTMLElement
    ).click(),
  );
const text = () => document.body.textContent ?? "";
const inputValues = () =>
  [...document.querySelectorAll("input, textarea")].map(
    (element) => (element as HTMLInputElement).value,
  );

it("offers only a schedule from Add trigger; a custom webhook waits behind Advanced", async () => {
  await using _env = await setup();
  await userEvent.click(page.getByRole("button", { name: "Add trigger" }));
  await expect.element(page.getByLabelText("Time of day")).toBeVisible();
  expect(page.getByRole("textbox", { name: "When this webhook fires" }).elements()).toHaveLength(0);
  expect(page.getByText("Custom webhook", { exact: true }).elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));

  expect(page.getByRole("button", { name: "Add custom webhook" }).elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Advanced: custom webhook" }));
  await userEvent.click(page.getByRole("button", { name: "Add custom webhook" }));
  await expect
    .element(page.getByRole("textbox", { name: "When this webhook fires" }))
    .toBeVisible();
});

it("reveals a webhook secret once and keeps its controls behind the disclosure", async () => {
  await using _env = await setup();
  await userEvent.click(page.getByRole("button", { name: "Advanced: custom webhook" }));
  await userEvent.click(page.getByRole("button", { name: "Add custom webhook" }));
  await userEvent.fill(
    page.getByRole("textbox", { name: "When this webhook fires" }),
    "When Sentry reports a new error in billing-service",
  );
  await userEvent.fill(
    page.getByRole("textbox", { name: "Instruction" }),
    "Triage the error and raise a decision",
  );
  await userEvent.click(page.getByRole("button", { name: "Add webhook" }));

  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByRole("textbox", { name: "Webhook secret" }))
    .toHaveValue("whsec_first");
  await expect
    .element(dialog.getByRole("textbox", { name: "Webhook URL" }))
    .toHaveValue(`https://box.example.ts.net/api/squire/hooks/${hookId}`);

  await closeDialog();
  await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
  expect(inputValues()).not.toContain("whsec_first");
  expect(text()).not.toContain("whsec_first");

  // Default view: the intent sentence, nothing of the custom webhook.
  await expect
    .element(page.getByText("When Sentry reports a new error in billing-service"))
    .toBeVisible();
  for (const name of ["Rotate", "Revoke", "Test now"]) {
    expect(page.getByRole("button", { name, exact: true }).elements()).toHaveLength(0);
  }
  expect(inputValues().some((value) => value.includes("/api/squire/hooks/"))).toBe(false);

  // The row's own disclosure, not the Add trigger one below the list.
  await userEvent.click(
    page.getByRole("listitem").getByRole("button", { name: "Advanced: custom webhook" }),
  );
  await expect
    .element(page.getByRole("textbox", { name: "Webhook URL" }))
    .toHaveValue(`https://box.example.ts.net/api/squire/hooks/${hookId}`);
  await expect.element(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Test now" })).toBeVisible();
  expect(inputValues()).not.toContain("whsec_first");

  await userEvent.fill(page.getByRole("textbox", { name: "Sample payload" }), '{"level":"error"}');
  await userEvent.click(page.getByRole("button", { name: "Test now" }));
  expect(commands.test).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ triggerId: hookId, samplePayload: '{"level":"error"}' }),
  });

  await userEvent.click(page.getByRole("button", { name: "Rotate" }));
  const rotated = page.getByRole("dialog");
  await expect.element(rotated.getByText("New webhook secret")).toBeVisible();
  await expect
    .element(rotated.getByRole("textbox", { name: "Webhook secret" }))
    .toHaveValue("whsec_rotated");
  await closeDialog();
  await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
  expect(inputValues()).not.toContain("whsec_rotated");
});

it("starts a just-listed webhook collapsed and shows a schedule's Test now by default", async () => {
  await using _env = await setup();
  await act(async () =>
    setTriggers([
      trigger({}),
      trigger({
        id: SquireTriggerId.make("trigger-schedule"),
        kind: "schedule",
        name: "Weekdays at 9:00",
        schedule: { kind: "daily", time: "09:00", weekdaysOnly: true },
      }),
    ]),
  );
  await expect.element(page.getByText(/^Weekdays at 9:00/)).toBeVisible();
  // The schedule's Test now is the only one; the webhook's sits behind its disclosure.
  expect(page.getByRole("button", { name: "Test now", exact: true }).elements()).toHaveLength(1);
  await expect
    .element(page.getByRole("listitem").getByRole("button", { name: "Advanced: custom webhook" }))
    .toHaveAttribute("aria-expanded", "false");
  await userEvent.click(page.getByRole("button", { name: "Test now" }));
  expect(commands.test).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ triggerId: SquireTriggerId.make("trigger-schedule") }),
  });
  expect(commands.test.mock.calls[0]?.[0].input).not.toHaveProperty("samplePayload");
});
