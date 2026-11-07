import { DEFAULT_RESOLVED_KEYBINDINGS } from "@lecturn/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { isMacPlatform } from "../../lib/utils";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatViewShortcuts, type ChatViewControls } from "./chatViewControls";

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

function Chat(props: { controls: ChatViewControls | undefined; toggleModelPicker: () => void }) {
  useChatViewShortcuts(props.controls, {
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    composerRef: {
      current: {
        toggleModelPicker: props.toggleModelPicker,
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return null;
}

function pressModelPickerChord() {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "m",
    metaKey: mac,
    ctrlKey: !mac,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer's chords run inside useChatShortcuts, so the allowlist has to deny them too.
it("passes a composer chord through when its control is not allowed", async () => {
  const toggleModelPicker = vi.fn();
  await using _setup = await render(
    <Chat controls={new Set(["send"])} toggleModelPicker={toggleModelPicker} />,
    { router: false },
  );

  const event = pressModelPickerChord();

  expect(toggleModelPicker).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("runs a composer chord when its control is allowed or there is no allowlist", async () => {
  const allowed = vi.fn();
  await using screen = await render(
    <Chat controls={new Set(["model-picker"])} toggleModelPicker={allowed} />,
    { router: false },
  );
  expect(pressModelPickerChord().defaultPrevented).toBe(true);
  expect(allowed).toHaveBeenCalledTimes(1);

  const unrestricted = vi.fn();
  await screen.rerender(<Chat controls={undefined} toggleModelPicker={unrestricted} />);
  expect(pressModelPickerChord().defaultPrevented).toBe(true);
  expect(unrestricted).toHaveBeenCalledTimes(1);
});
