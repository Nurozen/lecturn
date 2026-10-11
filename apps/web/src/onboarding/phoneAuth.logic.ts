import type { EnvironmentId } from "@lecturn/contracts";

export type PhoneAuthDriver = "codex" | "claudeAgent";

export function isPhoneLocalOnboarding({
  protocolVersion,
  mode,
  environmentId,
  primaryEnvironmentId,
}: {
  readonly protocolVersion: number | undefined;
  readonly mode: "local" | "connect" | "direct";
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    protocolVersion === 2 &&
    mode === "local" &&
    environmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

/** Only offer provider login URLs actually printed by this setup PTY. Never rebuild OAuth queries. */
export function isPhoneAuthUrl(value: string, driver: PhoneAuthDriver): boolean {
  if (value.length > 8192 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return driver === "codex"
      ? url.hostname === "auth.openai.com" && url.pathname === "/codex/device"
      : ["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) &&
          url.pathname === "/oauth/authorize";
  } catch {
    return false;
  }
}

export function readPhoneAuthPrompt(output: string, driver: PhoneAuthDriver) {
  // PTY chunks can split escape sequences or URLs. Read the retained text together;
  // soft terminal wrapping adds no newlines. OSC labels remain, hidden targets do not.
  const text = stripTerminalFormatting(output.slice(-65536)).replaceAll("\r", "");
  let url: string | null = null;
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\p{Cc}]+(?=\s)/gu)) {
    if (isPhoneAuthUrl(match[0], driver)) url = match[0];
  }
  return {
    url,
    // Fail closed when the CLI returns to a shell, is canceled, or someone types
    // directly in the terminal. A pasted code must never become a shell command.
    awaitingCode:
      driver === "claudeAgent" &&
      url !== null &&
      /Paste code here if prompted >[ \t\n]*$/.test(text),
  };
}

/** One input line only; reject terminal controls and shell syntax, including embedded newlines. */
export function phoneAuthCodeInput(value: string): string | null {
  const code = value.trim();
  if (code.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*#[A-Za-z0-9._~+/-]+=*$/.test(code)) {
    return null;
  }
  return `${code}\r`;
}

function stripTerminalFormatting(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }
    if (value[index + 1] === "[") {
      index += 2;
      while (index < value.length && !/[@-~]/.test(value[index]!)) index++;
    } else if (value[index + 1] === "]") {
      index += 2;
      while (index < value.length) {
        if (value.charCodeAt(index) === 7) break;
        if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
    } else {
      // Unknown escapes are a boundary, not part of a login URL.
      result += "\n";
    }
  }
  return result;
}
