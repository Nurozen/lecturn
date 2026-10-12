import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@lecturn/contracts";

export interface AndroidAccessState {
  readonly verified: boolean;
  readonly fullAccess: boolean;
  readonly computerUse: boolean;
  readonly revision: number | null;
  readonly capabilities: { readonly appData: boolean; readonly computerUse: boolean };
}

export interface AndroidChatWidgetSnapshot {
  readonly threadId: string;
  readonly title: string;
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
}

export interface AndroidHost {
  readonly protocolVersion: number;
  /** Native host explicitly supports the server-owned phone Connect account. */
  readonly connectAccount?: boolean;
  getAccessState(): Promise<AndroidAccessState>;
  requestFullAccess(threadId: string): Promise<AndroidAccessState>;
  openDeviceAccess(): Promise<AndroidAccessState>;
  publishChatWidget?(
    payload: AndroidChatWidgetSnapshot | null,
  ): Promise<{ readonly published: boolean }>;
}

declare global {
  interface Window {
    readonly symbaHost?: AndroidHost;
    __lecturnComposeRequested?: boolean;
  }
}

const ANDROID_ACCESS_REQUIRED =
  "Full access was not confirmed by Android. Review Device access or choose a different mode.";

function granted(state: AndroidAccessState | undefined): boolean {
  return (
    state?.verified === true &&
    state.fullAccess === true &&
    Number.isSafeInteger(state.revision) &&
    state.revision !== null &&
    state.revision >= 0 &&
    state.capabilities?.appData === true
  );
}

// Never cache a grant: native revocation must take effect on the next Full send.
export async function requireAndroidFullAccess(
  threadId: string,
  mode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  host = typeof window === "undefined" ? undefined : window.symbaHost,
): Promise<void> {
  if (mode !== "full-access" || host === undefined) return;
  if (host.protocolVersion !== 2) throw new Error(ANDROID_ACCESS_REQUIRED);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    const allowed = await Promise.race([
      (async () => {
        const state = await host.getAccessState();
        if (!active) return false;
        if (granted(state)) return true;
        // An unknown/disconnected host cannot authorize a new review.
        if (state?.verified !== true) return false;
        return granted(await host.requestFullAccess(threadId));
      })(),
      // Each native operation has a 90-second bound; allow both read and review to drain.
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 185_000);
      }),
    ]);
    if (!allowed) throw new Error(ANDROID_ACCESS_REQUIRED);
  } catch {
    throw new Error(ANDROID_ACCESS_REQUIRED);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

/** Chosen before React mounts; never infer phone auth from a user agent or loopback URL. */
export function hasPhoneConnectAccount(): boolean {
  return (
    typeof window !== "undefined" &&
    window.symbaHost?.protocolVersion === 2 &&
    window.symbaHost.connectAccount === true
  );
}
