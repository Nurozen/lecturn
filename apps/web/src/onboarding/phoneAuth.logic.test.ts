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
  "https://claude.ai/oauth/authorize?code=true&state=synthetic%2Bstate&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&client_id=synthetic&response_type=code&code_challenge=synthetic_challenge";
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
  it("recognizes the Claude 2.1.291 phone endpoint and preserves its full query", () => {
    const current = claudeUrl.replace("claude.ai/oauth", "claude.com/cai/oauth");
    expect(
      readPhoneAuthPrompt(
        `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${current}\r\nPaste code here if prompted > `,
        "claudeAgent",
      ),
    ).toEqual({
      url: current,
      awaitingCode: true,
      deviceCode: null,
    });
    for (const bad of [
      current.replace("claude.com", "claude.com.evil.test"),
      current.replace("/cai/oauth", "/oauth"),
      current.replace("https://", "http://"),
    ]) {
      expect(isPhoneAuthUrl(bad, "claudeAgent")).toBe(false);
    }
  });
  it("recovers hard wraps at every URL position, including host, path and percent escapes", () => {
    for (let split = 8; split < claudeUrl.length; split++) {
      const wrapped = `${claudeUrl.slice(0, split)}\r\n  \x1b[36m${claudeUrl.slice(split)}\x1b[0m\r\n\r\nPaste code here if prompted > `;
      expect(readPhoneAuthPrompt(wrapped, "claudeAgent").url).toBe(claudeUrl);
      expect(readPhoneAuthPrompt(wrapped, "claudeAgent").awaitingCode).toBe(true);
      expect(readPhoneAuthPrompt(`${claudeUrl.slice(0, split)}\n  `, "claudeAgent").url).toBeNull();
      // A partial final chunk must not expose a truncated URL.
      expect(
        readPhoneAuthPrompt(
          `${claudeUrl.slice(0, split)}\n  ${claudeUrl.slice(split)}`,
          "claudeAgent",
        ).url,
      ).toBeNull();
    }
  });
  it("handles repeated narrow wraps and refuses incomplete OAuth queries", () => {
    const wrapped = claudeUrl.match(/.{1,24}/g)!.join("\n  ");
    expect(
      readPhoneAuthPrompt(`${wrapped}\n\nPaste code here if prompted > `, "claudeAgent").url,
    ).toBe(claudeUrl);
    expect(
      readPhoneAuthPrompt("https://claude.ai/oauth/authorize?code=true\n", "claudeAgent").url,
    ).toBeNull();
    expect(readPhoneAuthPrompt(`${claudeUrl}\n\nRun this command next\n`, "claudeAgent").url).toBe(
      claudeUrl,
    );
  });
  it("does not repair a wrapped unapproved authority into a trusted login", () => {
    for (const bad of [
      "https://claude.ai.evil.test",
      "https://evil.test@claude.ai",
      "http://claude.ai",
      "https://claude.ai:3773",
    ]) {
      const value = claudeUrl.replace("https://claude.ai", bad);
      expect(
        readPhoneAuthPrompt(value.match(/.{1,23}/g)!.join("\n") + "\n\n", "claudeAgent").url,
      ).toBeNull();
    }
  });
  it("extracts only a labeled device code after the latest approved Codex URL", () => {
    const challenge =
      "https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n\n  \x1b[1mABCD-EFGHJ\x1b[0m\n";
    expect(readPhoneAuthPrompt(challenge, "codex").deviceCode).toBe("ABCD-EFGHJ");
    expect(
      readPhoneAuthPrompt(challenge + "https://auth.openai.com/codex/device\n", "codex").deviceCode,
    ).toBeNull();
    expect(readPhoneAuthPrompt("Device code: ABCD-EFGH\n", "codex").deviceCode).toBeNull();
    expect(
      readPhoneAuthPrompt("https://auth.openai.com/codex/device\nrandom ABCD-EFGH\n", "codex")
        .deviceCode,
    ).toBeNull();
    expect(
      readPhoneAuthPrompt(challenge.replace("ABCD-EFGHJ\x1b[0m\n", "ABCD-E"), "codex").deviceCode,
    ).toBeNull();
  });
  it("recovers a wrapped Codex endpoint and a wrapped Claude code prompt", () => {
    const url = "https://auth.openai.com/codex/device";
    for (let split = 8; split < url.length; split++) {
      expect(
        readPhoneAuthPrompt(
          `${url.slice(0, split)}\n  ${url.slice(split)}\n\nEnter this one-time code:\nABCD-EFGHJ\n`,
          "codex",
        ),
      ).toEqual({ url, deviceCode: "ABCD-EFGHJ", awaitingCode: false });
    }
    expect(
      readPhoneAuthPrompt(`${claudeUrl}\n\nPaste code here if\n prompted > `, "claudeAgent")
        .awaitingCode,
    ).toBe(true);
  });
  it("preserves the exact OAuth query and enables code input only at the Claude prompt", () => {
    expect(readPhoneAuthPrompt(prompt, "claudeAgent")).toEqual({
      url: claudeUrl,
      awaitingCode: true,
      deviceCode: null,
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
      deviceCode: null,
    });
    expect(
      readPhoneAuthPrompt(`\x1b]8;;${claudeUrl}\x07Click here\x1b]8;;\x07\n`, "claudeAgent").url,
    ).toBeNull();
  });
  it("does not offer an incomplete URL or invent a URL before output arrives", () => {
    expect(readPhoneAuthPrompt(claudeUrl, "claudeAgent").url).toBeNull();
    expect(readPhoneAuthPrompt("", "codex")).toEqual({
      url: null,
      awaitingCode: false,
      deviceCode: null,
    });
    expect(readPhoneAuthPrompt("Paste code here if prompted > ", "claudeAgent").awaitingCode).toBe(
      false,
    );
  });
  it("offers the device URL without enabling Claude code input", () => {
    expect(
      readPhoneAuthPrompt(
        "Visit https://auth.openai.com/codex/device\nEnter this one-time code:\nABCD-EFGH\n",
        "codex",
      ),
    ).toEqual({
      url: "https://auth.openai.com/codex/device",
      awaitingCode: false,
      deviceCode: "ABCD-EFGH",
    });
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
    "code#state\n",
    "\ncode#state",
    "code#state\t",
    "code\r#state",
    "code\x1b#state",
    "$(whoami)#state",
    "code;exit#state",
    "a".repeat(4097) + "#state",
  ])("rejects malformed input or terminal/shell injection", (code) => {
    expect(phoneAuthCodeInput(code)).toBeNull();
  });
});
