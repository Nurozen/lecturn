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
  if (value.length > 8192 || /[\s\\\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return driver === "codex"
      ? url.hostname === "auth.openai.com" && url.pathname === "/codex/device"
      : ((url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize") ||
          (["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) &&
            url.pathname === "/oauth/authorize")) &&
          ["state", "redirect_uri", "client_id", "code_challenge"].every((key) =>
            Boolean(url.searchParams.get(key)),
          ) &&
          url.searchParams.get("response_type") === "code";
  } catch {
    return false;
  }
}

export function readPhoneAuthPrompt(output: string, driver: PhoneAuthDriver) {
  // Read retained chunks together so split escapes and hard-wrapped URLs can be
  // recovered. Only visible OSC labels count, never hidden hyperlink targets.
  const text = stripTerminalFormatting(output.slice(-65536)).replaceAll("\r", "");
  let url: string | null = null;
  let urlEnd = 0;
  for (const match of text.matchAll(/https:\/\//g)) {
    const start = match.index;
    const tail = text.slice(start);
    const first = tail.match(/^[^\s<>"'\p{Cc}]+/u)?.[0];
    if (!first) continue;
    let candidate = first;
    let end = first.length;
    // Codex prints a fixed endpoint. Claude prints a long OAuth query that
    // some CLI renderers wrap onto indented lines, including inside escapes.
    while (tail[end] === "\n") {
      if (driver === "codex" && isPhoneAuthUrl(candidate, driver)) break;
      const next = tail.slice(end + 1).match(/^[ \t]*([^\s<>"'\p{Cc}]+)(?=\n|$)/u);
      if (!next || /^https?:\/\//.test(next[1]!)) break;
      candidate += next[1];
      end += 1 + next[0].length;
    }
    if (!/[\s<>"']/.test(tail[end] ?? "")) continue;
    // A lone final newline may be a hard wrap whose continuation has not
    // arrived yet. Wait for a blank separator or the following CLI message.
    if (driver === "claudeAgent" && /^\n[ \t]*$/.test(tail.slice(end))) continue;
    if (isPhoneAuthUrl(candidate, driver)) {
      url = candidate;
      urlEnd = start + end;
    }
  }
  // Codes belong to the latest device challenge, not an older attempt in the
  // scrollback. Require the CLI's code label, not an arbitrary token in a URL.
  const deviceCode =
    driver === "codex" && url !== null
      ? (text
          .slice(urlEnd)
          .match(
            /(?:one[- ]time|device)\s+code[^\n:]*:?[ \t\n]*([A-Z0-9]{4}-[A-Z0-9]{4,5})(?=\s)/i,
          )?.[1] ?? null)
      : null;
  return {
    url,
    deviceCode,
    // Fail closed when the CLI returns to a shell, is canceled, or someone types
    // directly in the terminal. A pasted code must never become a shell command.
    awaitingCode:
      driver === "claudeAgent" &&
      url !== null &&
      /Paste\s+code\s+here\s+if\s+prompted\s*>[ \t\n]*$/.test(text),
  };
}

/** One input line only; reject terminal controls and shell syntax, including embedded newlines. */
export function phoneAuthCodeInput(value: string): string | null {
  if (/\p{Cc}/u.test(value)) return null;
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
