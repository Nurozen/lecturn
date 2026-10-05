import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

export class ClipboardReadUnavailableError extends Schema.TaggedErrorClass<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while reading ${this.target}.`;
  }
}

export class ClipboardReadError extends Schema.TaggedErrorClass<ClipboardReadError>()(
  "ClipboardReadError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.target} from the clipboard.`;
  }
}

/** Electron's app scheme can reject async clipboard writes despite a user click. */
function writeThroughDesktopSelection(value: string): boolean {
  if (
    !window.desktopBridge ||
    typeof document === "undefined" ||
    typeof document.execCommand !== "function"
  )
    return false;
  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(input);
  try {
    input.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
    // The clicked control/selection may have disappeared during the async API.
    try {
      if (active instanceof HTMLElement) active.focus({ preventScroll: true });
      selection?.removeAllRanges();
      for (const range of ranges) selection?.addRange(range);
    } catch {
      // Clipboard success is independent of restoring a detached selection.
    }
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!navigator.clipboard?.writeText) {
    if (value && writeThroughDesktopSelection(value)) return true;
    throw new ClipboardApiUnavailableError({ target });
  }
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    if (writeThroughDesktopSelection(value)) return true;
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

export async function readTextFromClipboard(target = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError({
      target,
    });
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError({
      target,
      cause,
    });
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
