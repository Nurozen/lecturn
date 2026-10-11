import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  terminalOutputText,
  type TerminalOutputState,
} from "@lecturn/client-runtime/state/terminal";

vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
const copy = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: copy }));
import { PhoneAuthControls } from "./PhoneAuthControls";

const url = "https://claude.ai/oauth/authorize?state=synthetic%2Bstate&code=true";
function terminalOutput(data: string): TerminalOutputState {
  const byteLength = new TextEncoder().encode(data).length;
  return {
    generation: 0,
    resetVersion: 0,
    nextOffset: data.length,
    retainedBytes: byteLength,
    chunks: [{ startOffset: 0, data, byteLength }],
  };
}
const output = terminalOutput(`${url}\r\nPaste code here if prompted > `);
let renderer: ReactTestRenderer;
const writeInput = vi.fn(async (_data: string) => true);
const refresh = vi.fn(async () => true);
const props = {
  driver: "claudeAgent" as const,
  command: "claude auth login",
  commandReady: true,
  output,
  writeInput,
  onRefresh: refresh,
};
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const contents = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

async function mount(next = props) {
  await act(async () => {
    renderer = create(<PhoneAuthControls {...next} />);
  });
}

async function typeCode(code: string) {
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ currentTarget: { value: code } }),
  );
}

describe("phone authentication controls", () => {
  it("waits for a user action, sends Enter once, and prevents a duplicate pending command", async () => {
    let finish: (value: boolean) => void = () => {};
    writeInput.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount({ ...props, output: terminalOutput("") });
    expect(writeInput).not.toHaveBeenCalled();
    const run = button("Run sign-in command");
    await act(async () => {
      run.props.onClick();
      run.props.onClick();
    });
    expect(writeInput.mock.calls).toEqual([["\r"]]);
    await act(async () => finish(false));
    expect(contents()).toContain("Could not confirm input");
    expect(button("Run sign-in command")).toBeUndefined();
  });

  it("opens/copies the actual printed URL and does not send auth material during refresh", async () => {
    copy.mockResolvedValueOnce(true);
    await mount();
    expect(renderer.root.findByType("a").props.href).toBe(url);
    await act(async () => button("Copy link").props.onClick());
    expect(copy).toHaveBeenCalledWith(url, "login link");
    await act(async () => button("Refresh sign-in status").props.onClick());
    expect(refresh).toHaveBeenCalledOnce();
    expect(writeInput).not.toHaveBeenCalled();
  });

  it("rejects multiline input, clears a submitted code immediately, and blocks double submit", async () => {
    await mount();
    await typeCode("synthetic#state\nwhoami");
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(writeInput).not.toHaveBeenCalled();
    expect(contents()).toContain("on one line");
    await typeCode("synthetic#state");
    let finish: (value: boolean) => void = () => {};
    writeInput.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const submit = renderer.root.findByType("form").props.onSubmit;
    await act(async () => {
      void submit({ preventDefault() {} });
      void submit({ preventDefault() {} });
    });
    expect(writeInput.mock.calls).toEqual([["synthetic#state\r"]]);
    expect(renderer.root.findByType("input").props.value).toBe("");
    await act(async () => finish(true));
    expect(contents()).toContain("Code sent");
  });

  it("discards the input when the CLI leaves the prompt or prints a replacement login URL", async () => {
    await mount();
    await typeCode("synthetic#state");
    const ended = terminalOutput(terminalOutputText(output) + "\r\nLogin successful.\r\n$ ");
    await act(async () => renderer.update(<PhoneAuthControls {...props} output={ended} />));
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    await act(async () => renderer.update(<PhoneAuthControls {...props} />));
    expect(renderer.root.findByType("input").props.value).toBe("");
    await typeCode("synthetic#state");
    const replacement = terminalOutput(`${url}&new=synthetic\nPaste code here if prompted > `);
    await act(async () => renderer.update(<PhoneAuthControls {...props} output={replacement} />));
    expect(renderer.root.findByType("input").props.value).toBe("");
  });

  it("shows generic failures without logging exception messages containing auth material", async () => {
    const error = vi.spyOn(console, "error");
    await mount();
    error.mockClear();
    copy.mockRejectedValueOnce(new Error("synthetic secret URL"));
    await act(async () => button("Copy link").props.onClick());
    await typeCode("synthetic#state");
    writeInput.mockRejectedValueOnce(new Error("synthetic secret code"));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    refresh.mockRejectedValueOnce(new Error("synthetic secret error"));
    await act(async () => button("Refresh sign-in status").props.onClick());
    expect(error).not.toHaveBeenCalled();
    expect(contents()).not.toContain("synthetic secret");
    expect(contents()).toContain("Could not refresh");
    error.mockRestore();
  });
});
