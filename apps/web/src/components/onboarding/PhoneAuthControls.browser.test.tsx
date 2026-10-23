import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  terminalOutputText,
  type TerminalOutputState,
} from "@lecturn/client-runtime/state/terminal";

const copy = vi.hoisted(() => vi.fn());
vi.mock(import("../../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: copy,
}));
import { PhoneAuthControls } from "./PhoneAuthControls";

const url =
  "https://claude.ai/oauth/authorize?state=synthetic%2Bstate&code=true&redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcode%2Fcallback&client_id=synthetic&response_type=code&code_challenge=synthetic_challenge";
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
let root: Root | null = null;
let container: HTMLDivElement;
const writeInput = vi.fn(async (_data: string) => true);
const refresh = vi.fn(async () => true);
const props = {
  driver: "claudeAgent" as const,
  command: "claude auth login",
  commandReady: true,
  output,
  writeInput,
  onRefresh: refresh,
  onRestart: vi.fn(),
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const contents = () => container.textContent ?? "";
const press = (label: string) => act(async () => button(label).click());
const codeInput = () => container.querySelector("input")!;
const link = () => container.querySelector("a")!.getAttribute("href");
const render = (element: ReactElement) => act(async () => root!.render(element));
const submit = () =>
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(next = props) {
  await render(<PhoneAuthControls {...next} />);
}

async function typeCode(code: string) {
  const input = codeInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("phone authentication controls", () => {
  it("shows and copies a Codex device code without terminal selection or sending input", async () => {
    copy.mockResolvedValueOnce(true);
    const codexProps = {
      ...props,
      driver: "codex" as const,
      command: "codex login --device-auth",
      output: terminalOutput(
        "https://auth.openai.com/codex/device\n\nEnter this one-time code:\n\x1b[1mABCD-EFGHJ\x1b[0m\n",
      ),
    };
    await render(<PhoneAuthControls {...codexProps} />);
    expect(contents()).toContain("ABCD-EFGHJ");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    await press("Copy device code");
    expect(copy).toHaveBeenCalledWith("ABCD-EFGHJ", "device code");
    expect(writeInput).not.toHaveBeenCalled();
    expect(contents()).toContain("Device code copied.");
    await render(<PhoneAuthControls {...codexProps} output={terminalOutput("")} />);
    expect(contents()).not.toContain("ABCD-EFGHJ");
    expect(button("Copy device code")).toBeUndefined();
  });

  it("copies the complete reconstructed Claude link outside the terminal", async () => {
    await mount({
      ...props,
      output: terminalOutput(
        url.match(/.{1,28}/g)!.join("\r\n  ") + "\r\n\r\nPaste code here if prompted > ",
      ),
    });
    expect(link()).toBe(url);
    await press("Copy link");
    expect(copy).toHaveBeenCalledWith(url, "login link");
    await typeCode("synthetic#state");
    await act(async () => void submit());
    expect(writeInput.mock.calls).toEqual([["synthetic#state\r"]]);
  });
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
      run.click();
      run.click();
    });
    expect(writeInput.mock.calls).toEqual([["\r"]]);
    await act(async () => finish(false));
    expect(contents()).toContain("Could not confirm input");
    expect(button("Run sign-in command")).toBeUndefined();
  });

  it("opens/copies the actual printed URL and does not send auth material during refresh", async () => {
    copy.mockResolvedValueOnce(true);
    await mount();
    expect(link()).toBe(url);
    await press("Copy link");
    expect(copy).toHaveBeenCalledWith(url, "login link");
    await press("Refresh sign-in status");
    expect(refresh).toHaveBeenCalledOnce();
    expect(writeInput).not.toHaveBeenCalled();
  });

  it("rejects input that is not one code#state token, clears a submitted code immediately, and blocks double submit", async () => {
    await mount();
    // A browser input drops line breaks, so a second command arrives space-separated.
    await typeCode("synthetic#state whoami");
    await act(async () => void submit());
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
    await act(async () => {
      submit();
      submit();
    });
    expect(writeInput.mock.calls).toEqual([["synthetic#state\r"]]);
    expect(codeInput().value).toBe("");
    await act(async () => finish(true));
    expect(contents()).toContain("Code sent");
  });

  it("discards the input when the CLI leaves the prompt or prints a replacement login URL", async () => {
    await mount();
    await typeCode("synthetic#state");
    const ended = terminalOutput(terminalOutputText(output) + "\r\nLogin successful.\r\n$ ");
    await render(<PhoneAuthControls {...props} output={ended} />);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    await render(<PhoneAuthControls {...props} />);
    expect(codeInput().value).toBe("");
    await typeCode("synthetic#state");
    const replacement = terminalOutput(`${url}&new=synthetic\nPaste code here if prompted > `);
    await render(<PhoneAuthControls {...props} output={replacement} />);
    expect(codeInput().value).toBe("");
  });

  it("keeps ended sign-in visible, removes stale auth inputs, and reports refresh failures", async () => {
    await mount();
    await typeCode("synthetic#state");
    await render(<PhoneAuthControls {...props} sessionEnded />);
    expect(contents()).toContain("The sign-in terminal ended");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    refresh.mockResolvedValueOnce(false);
    await press("Refresh sign-in status");
    expect(contents()).toContain("Could not refresh sign-in status");
    await press("Start sign-in again");
    expect(props.onRestart).toHaveBeenCalledOnce();
    expect(writeInput).not.toHaveBeenCalled();
  });

  it("offers explicit recovery without silently rerunning or sending the old code", async () => {
    await mount();
    await typeCode("synthetic#state");
    await press("Start sign-in again");
    expect(props.onRestart).toHaveBeenCalledOnce();
    expect(writeInput).not.toHaveBeenCalled();
    expect(contents()).toContain("Login links can expire");
  });

  it("shows generic failures without logging exception messages containing auth material", async () => {
    const error = vi.spyOn(console, "error");
    await mount();
    error.mockClear();
    copy.mockRejectedValueOnce(new Error("synthetic secret URL"));
    await press("Copy link");
    await typeCode("synthetic#state");
    writeInput.mockRejectedValueOnce(new Error("synthetic secret code"));
    await act(async () => void submit());
    refresh.mockRejectedValueOnce(new Error("synthetic secret error"));
    await press("Refresh sign-in status");
    expect(error).not.toHaveBeenCalled();
    expect(contents()).not.toContain("synthetic secret");
    expect(contents()).toContain("Could not refresh");
    error.mockRestore();
  });
});
