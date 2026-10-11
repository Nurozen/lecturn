import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isPhoneAuthUrl,
  isPhoneLocalOnboarding,
  phoneAuthCodeInput,
  readPhoneAuthPrompt,
} from "./phoneAuth.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const claudeUrl =
  "https://claude.ai/oauth/authorize?code=true&state=synthetic%2Bstate&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const prompt = `If the browser didn't open, visit: ${claudeUrl}\r\nPaste code here if prompted > `;

describe("phone-local auth scope", () => {
  it.each([undefined, 1, 2, 3])(
    "requires protocol 2 and the local primary target (%s)",
    (protocolVersion) => {
      for (const mode of ["local", "connect", "direct"] as const) {
        for (const environmentId of [null, local, remote]) {
          expect(
            isPhoneLocalOnboarding({
              protocolVersion,
              mode,
              environmentId,
              primaryEnvironmentId: local,
            }),
          ).toBe(protocolVersion === 2 && mode === "local" && environmentId === local);
        }
      }
      expect(
        isPhoneLocalOnboarding({
          protocolVersion,
          mode: "local",
          environmentId: null,
          primaryEnvironmentId: null,
        }),
      ).toBe(false);
    },
  );
});

describe("printed phone login URLs", () => {
  it("preserves the exact OAuth query and enables code input only at the Claude prompt", () => {
    expect(readPhoneAuthPrompt(prompt, "claudeAgent")).toEqual({
      url: claudeUrl,
      awaitingCode: true,
    });
    for (const suffix of [
      "synthetic#state",
      "\r\nLogin successful.\r\n$ ",
      "\r\nLogin failed: canceled\r\n$ ",
      "^C\r\n$ ",
    ]) {
      expect(readPhoneAuthPrompt(prompt + suffix, "claudeAgent").awaitingCode).toBe(false);
    }
  });
  it("handles PTY chunk splits and terminal formatting without using hidden OSC targets", () => {
    const chunks = [
      "\x1b[32mIf the browser didn't open, visit: \x1b]8;;https://evil.test\x07",
      claudeUrl.slice(0, 50),
      claudeUrl.slice(50),
      "\x1b]8;;\x07\x1b[0m\r\nPaste code here if prompted > ",
    ];
    expect(readPhoneAuthPrompt(chunks.join(""), "claudeAgent")).toEqual({
      url: claudeUrl,
      awaitingCode: true,
    });
    expect(
      readPhoneAuthPrompt(`\x1b]8;;${claudeUrl}\x07Click here\x1b]8;;\x07\n`, "claudeAgent").url,
    ).toBeNull();
  });
  it("does not offer an incomplete URL or invent a URL before output arrives", () => {
    expect(readPhoneAuthPrompt(claudeUrl, "claudeAgent").url).toBeNull();
    expect(readPhoneAuthPrompt("", "codex")).toEqual({ url: null, awaitingCode: false });
    expect(readPhoneAuthPrompt("Paste code here if prompted > ", "claudeAgent").awaitingCode).toBe(
      false,
    );
  });
  it("offers the device URL without enabling Claude code input", () => {
    expect(
      readPhoneAuthPrompt("Visit https://auth.openai.com/codex/device\nEnter ABCD-EFGH\n", "codex"),
    ).toEqual({ url: "https://auth.openai.com/codex/device", awaitingCode: false });
  });
  it.each([
    "http://claude.ai/oauth/authorize",
    "javascript:alert(1)",
    "file:///oauth/authorize",
    "https://localhost/oauth/authorize",
    "https://127.0.0.1/oauth/authorize",
    "https://claude.ai.evil.test/oauth/authorize",
    "https://user:pass@claude.ai/oauth/authorize",
    "https://evil.test@claude.ai/oauth/authorize",
    "https://claude.ai:3773/oauth/authorize",
    "https://claude.ai/oauth/authorize\\evil",
    "https://claude.ai/docs",
    "https://claude.ai/oauth/authorize\n",
  ])("rejects non-login or unsafe URL %s", (url) => {
    expect(isPhoneAuthUrl(url, "claudeAgent")).toBe(false);
  });
  it("ignores docs and other-provider links and chooses the latest printed login", () => {
    const next = `${claudeUrl}&login_hint=synthetic`;
    expect(
      readPhoneAuthPrompt(
        `${prompt}\n${next}\nhttps://claude.ai/docs\nhttps://auth.openai.com/codex/device\n`,
        "claudeAgent",
      ).url,
    ).toBe(next);
    expect(readPhoneAuthPrompt("unrelated\n".repeat(7000), "claudeAgent").url).toBeNull();
  });
});

describe("manual code input", () => {
  it("sends the complete code and state as one PTY line", () => {
    expect(phoneAuthCodeInput(" synthetic_code#synthetic-state ")).toBe(
      "synthetic_code#synthetic-state\r",
    );
  });
  it.each([
    "",
    "code",
    "code#",
    "#state",
    "code#state#extra",
    "code#state\nwhoami",
    "code\r#state",
    "code\x1b#state",
    "$(whoami)#state",
    "code;exit#state",
    "a".repeat(4097) + "#state",
  ])("rejects malformed input or terminal/shell injection", (code) => {
    expect(phoneAuthCodeInput(code)).toBeNull();
  });
});
