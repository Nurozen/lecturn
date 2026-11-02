import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId, SquireId, SquireRoomId } from "@lecturn/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock(import("../../../state/squires"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const companion = (palette: string, appearance: string) => ({
    presence: "figure",
    appearance,
    hood: "down",
    palette,
  });
  const entries = [
    { squire: { id: "research", name: "Research", companion: companion("sage", "female") } },
    { squire: { id: "lead", name: "Lead", companion: companion("brass", "male") } },
  ];
  return {
    ...actual,
    useSquireEnvironmentState: (() => ({ squires: entries, lead: "lead" })) as never,
    squireEnvironment: {
      ...actual.squireEnvironment,
      roomPost: { ...actual.squireEnvironment.roomPost, permissionAtom: () => allowed },
    },
  };
});
vi.mock(import("../../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { SquireRoomComposer } from "./SquireRoomComposer";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const setTextareaValue = (element: HTMLTextAreaElement, value: string, caret: number) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    element,
    value,
  );
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

it("keeps the caret after a picked mention, so the next keystroke lands there", async () => {
  await act(async () =>
    root.render(
      <RegistryProvider>
        <SquireRoomComposer
          environmentId={"env" as EnvironmentId}
          roomId={"room" as SquireRoomId}
          members={[
            { squireId: "research" as SquireId, name: "Research" },
            { squireId: "release" as SquireId, name: "Release" },
          ]}
          lead={null}
          closed={false}
        />
      </RegistryProvider>,
    ),
  );
  const textarea = container.querySelector("textarea")!;
  textarea.focus();
  await act(async () => setTextareaValue(textarea, "@Res can you check", 4));
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();

  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  // Checked in the same task as the pick: a keystroke arriving before the next frame must not
  // find the caret at the end, where setting the controlled value left it.
  expect(textarea.value).toBe("@Research can you check");
  expect(textarea.selectionStart).toBe(10);
  expect(textarea.selectionEnd).toBe(10);
});

it("shows each candidate's still face beside its name, the Lead with its crest", async () => {
  await act(async () =>
    root.render(
      <RegistryProvider>
        <SquireRoomComposer
          environmentId={"env" as EnvironmentId}
          roomId={"room" as SquireRoomId}
          members={[{ squireId: "research" as SquireId, name: "Research" }]}
          lead={{ squireId: "lead" as SquireId, name: "Lead" }}
          closed={false}
        />
      </RegistryProvider>,
    ),
  );
  const textarea = container.querySelector("textarea")!;
  textarea.focus();
  await act(async () => setTextareaValue(textarea, "@", 1));
  const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  const faces = options.map((option) => ({
    name: option.querySelector(".truncate")?.textContent,
    portrait: option.querySelector<HTMLImageElement>('[data-slot="squire-portrait"]')?.src,
    crest: option.querySelector('[data-slot="squire-crest"]') !== null,
  }));
  expect(faces.map(({ name, crest }) => ({ name, crest }))).toEqual([
    { name: "Lead", crest: true },
    { name: "Research", crest: false },
  ]);
  expect(faces[0]!.portrait).toContain("male-down-gold");
  expect(faces[1]!.portrait).toContain("female-down-sage");
  const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
  expect(listbox.getAnimations({ subtree: true })).toEqual([]);
});
