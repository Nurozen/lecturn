import {
  RelayBillingRedirect,
  RelayBillingStatus,
  type RelayBillingInterval,
} from "@lecturn/contracts";
import { normalizeSecureRelayUrl } from "@lecturn/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const BILLING_REQUEST_TIMEOUT_MS = 15_000;

const decodeBillingStatus = Schema.decodeUnknownSync(RelayBillingStatus);
const decodeBillingRedirect = Schema.decodeUnknownSync(RelayBillingRedirect);

export class BillingRequestError extends Error {
  readonly reason: "unauthenticated" | "unavailable" | "rejected";
  constructor(reason: "unauthenticated" | "unavailable" | "rejected") {
    super(
      reason === "unauthenticated"
        ? "Sign in to view your subscription."
        : reason === "unavailable"
          ? "Billing is currently unavailable. Your subscription status could not be checked."
          : "The billing request could not be completed. Refresh your status and try again.",
    );
    this.reason = reason;
  }
}

/** Account authentication is independent of any connected environment. Never infer unpaid from a failed request. */
export function createBillingClient(options: {
  relayUrl: string;
  getToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request(path: string, body?: unknown): Promise<unknown> {
    if (!relayUrl) throw new BillingRequestError("unavailable");
    // Bound token acquisition and body reads too. Never submit after a late token resolves.
    const execute = async (signal: AbortSignal) => {
      const token = await options.getToken();
      if (signal.aborted) throw new BillingRequestError("unavailable");
      if (!token) throw new BillingRequestError("unauthenticated");
      let response: Response;
      try {
        response = await fetcher(`${relayUrl}/v1/billing/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch {
        throw new BillingRequestError("unavailable");
      }
      if (response.status === 401) throw new BillingRequestError("unauthenticated");
      if (response.status === 404 || response.status >= 500)
        throw new BillingRequestError("unavailable");
      if (!response.ok) throw new BillingRequestError("rejected");
      try {
        return await response.json();
      } catch {
        throw new BillingRequestError("unavailable");
      }
    };
    const result = await Effect.runPromise(
      Effect.tryPromise({
        try: execute,
        catch: (error) =>
          error instanceof BillingRequestError ? error : new BillingRequestError("unavailable"),
      }).pipe(
        Effect.timeoutOption(BILLING_REQUEST_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new BillingRequestError("unavailable")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.match({
          onFailure: (error) => ({ ok: false, error }) as const,
          onSuccess: (value) => ({ ok: true, value }) as const,
        }),
      ),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  async function status(path: string, body?: unknown) {
    const raw = await request(path, body);
    try {
      return decodeBillingStatus(raw);
    } catch {
      throw new BillingRequestError("unavailable");
    }
  }
  async function redirect(path: string, body: unknown) {
    const raw = await request(path, body);
    try {
      const { url } = decodeBillingRedirect(raw);
      const parsed = new URL(url);
      const expectedHost = path === "checkout" ? "checkout.stripe.com" : "billing.stripe.com";
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== expectedHost ||
        parsed.username ||
        parsed.password ||
        parsed.port
      )
        throw new Error("Invalid billing destination");
      return url;
    } catch {
      throw new BillingRequestError("unavailable");
    }
  }
  return {
    getStatus: () => status("status"),
    checkout: (interval: RelayBillingInterval) => redirect("checkout", { interval }),
    portal: () => redirect("portal", {}),
    reconcile: (sessionId: string) => status("checkout/reconcile", { sessionId }),
  };
}
