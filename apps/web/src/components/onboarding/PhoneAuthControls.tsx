import {
  terminalOutputText,
  type TerminalOutputState,
} from "@lecturn/client-runtime/state/terminal";
import { useId, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  phoneAuthCodeInput,
  readPhoneAuthPrompt,
  type PhoneAuthDriver,
} from "../../onboarding/phoneAuth.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PhoneAuthControls({
  driver,
  command,
  commandReady,
  output,
  writeInput,
  onRefresh,
  onRestart,
  sessionEnded = false,
}: {
  readonly driver: PhoneAuthDriver;
  readonly command: string;
  readonly commandReady: boolean;
  readonly output: TerminalOutputState | null;
  readonly writeInput: (data: string) => Promise<boolean>;
  readonly onRefresh: () => Promise<boolean>;
  readonly onRestart: () => void;
  readonly sessionEnded?: boolean;
}) {
  const prompt = useMemo(
    () => readPhoneAuthPrompt(output === null ? "" : terminalOutputText(output), driver),
    [driver, output],
  );
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(false);
  const [notice, setNotice] = useState("");

  const runCommand = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    // Do not resend a command after an ambiguous transport failure.
    setStarted(true);
    try {
      if (!(await writeInput("\r"))) {
        setNotice("Could not confirm input. Check the terminal, or close and retry sign-in.");
      }
    } catch {
      setNotice("Could not confirm input. Check the terminal, or close and retry sign-in.");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3 border-b border-border/60 bg-accent/30 p-3 text-sm">
      <p className="leading-relaxed text-muted-foreground">
        {sessionEnded
          ? "The sign-in terminal ended. Refresh status to check whether sign-in completed, or start again for a new login link."
          : driver === "codex"
            ? "Copy the device code below, then open login in your phone’s browser. If asked, enable device code login in your account settings. Then return here."
            : "Open login in your phone’s browser. Copy the full code#state shown after sign-in, return here, and paste it below."}
      </p>
      {!sessionEnded && !started && prompt.url === null && commandReady ? (
        <div className="space-y-2">
          <code className="block break-all font-mono text-xs">{command}</code>
          <Button className="min-h-12 w-full" disabled={busy} onClick={() => void runCommand()}>
            Run sign-in command
          </Button>
        </div>
      ) : null}
      {!sessionEnded && prompt.deviceCode !== null ? (
        <PhoneAuthDeviceCode key={`device:${prompt.deviceCode}`} code={prompt.deviceCode} />
      ) : null}
      {!sessionEnded && prompt.url !== null ? (
        <PhoneAuthLink key={prompt.url} url={prompt.url} />
      ) : !sessionEnded ? (
        <p className="text-xs text-muted-foreground">
          The login link will appear after the command runs.
        </p>
      ) : null}
      {!sessionEnded && prompt.awaitingCode ? (
        <PhoneAuthCodeEntry key={`code:${prompt.url}`} writeInput={writeInput} />
      ) : null}
      <Button
        className="min-h-12 w-full"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          if (pendingRef.current) return;
          pendingRef.current = true;
          setBusy(true);
          setNotice("");
          try {
            const refreshed = await onRefresh();
            setNotice(
              refreshed
                ? "Status refreshed. Check the agent cards above."
                : "Could not refresh sign-in status. Try again.",
            );
          } catch {
            setNotice("Could not refresh sign-in status. Try again.");
          } finally {
            pendingRef.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? "Please wait…" : "Refresh sign-in status"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Return to this panel after using the browser. Login links can expire at the provider; if
        login stops responding, start again for a new link.
      </p>
      <Button className="min-h-12 w-full" variant="outline" disabled={busy} onClick={onRestart}>
        Start sign-in again
      </Button>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function PhoneAuthDeviceCode({ code }: { readonly code: string }) {
  const [notice, setNotice] = useState("");
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs font-medium">Device code</p>
      <code className="block break-all text-xl tracking-wider">{code}</code>
      <Button
        className="min-h-12 w-full"
        variant="outline"
        onClick={async () => {
          try {
            const copied = await writeTextToClipboard(code, "device code");
            setNotice(
              copied ? "Device code copied." : "Could not copy. Enter the code shown above.",
            );
          } catch {
            setNotice("Could not copy. Enter the code shown above.");
          }
        }}
      >
        Copy device code
      </Button>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function PhoneAuthLink({ url }: { readonly url: string }) {
  const [notice, setNotice] = useState("");
  return (
    <div className="space-y-2">
      <p className="break-all text-xs text-muted-foreground">{new URL(url).hostname}</p>
      <div className="flex flex-wrap gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="inline-flex min-h-12 min-w-0 basis-full items-center justify-center rounded-md bg-primary px-4 py-2 text-center font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring sm:basis-auto sm:flex-1"
        >
          Open login in browser
        </a>
        <Button
          className="min-h-12 w-full sm:w-auto"
          variant="outline"
          onClick={async () => {
            try {
              const copied = await writeTextToClipboard(url, "login link");
              setNotice(copied ? "Login link copied." : "Could not copy. Use the link above.");
            } catch {
              // Clipboard errors can contain the URL; keep them out of logs and toasts.
              setNotice("Could not copy. Use the link above.");
            }
          }}
        >
          Copy link
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function PhoneAuthCodeEntry({
  writeInput,
}: {
  readonly writeInput: (data: string) => Promise<boolean>;
}) {
  const id = useId();
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(false);
  return (
    <form
      className="scroll-my-4 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pendingRef.current) return;
        const input = phoneAuthCodeInput(code);
        if (input === null) {
          setNotice("Paste the full code#state from the browser, on one line.");
          return;
        }
        pendingRef.current = true;
        setBusy(true);
        setCode("");
        try {
          const sent = await writeInput(input);
          setNotice(
            sent
              ? "Code sent. Check the terminal, then refresh sign-in status."
              : "Could not confirm input. Check the terminal before trying again.",
          );
        } catch {
          setNotice("Could not confirm input. Check the terminal before trying again.");
        } finally {
          pendingRef.current = false;
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id} className="block text-xs font-medium">
        Code from browser
      </label>
      <Input
        id={id}
        type="password"
        nativeInput
        font="touch"
        className="[&_input]:min-h-12"
        enterKeyHint="send"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="code#state"
        value={code}
        disabled={busy}
        onChange={(event) => setCode(event.currentTarget.value)}
      />
      <Button className="min-h-12 w-full" type="submit" disabled={busy || code.trim() === ""}>
        Send code to terminal
      </Button>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
