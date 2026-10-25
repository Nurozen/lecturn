// @effect-diagnostics globalFetch:off -- Promise API for hosts that run no Effect runtime.
import { AppPairingPoll, AppPairingRequestCreated, AppRegistration } from "@lecturn/contracts/apps";
import {
  APPS_PAIRING_REQUESTS_PATH,
  APPS_POLL_SECRET_HEADER,
  appsPairingRequestPath,
} from "@lecturn/contracts/appsHttp";
import * as Schema from "effect/Schema";

const encodeRegistration = Schema.encodeSync(Schema.toCodecJson(AppRegistration));
const decodeCreated = Schema.decodeUnknownSync(Schema.toCodecJson(AppPairingRequestCreated));
const decodePoll = Schema.decodeUnknownSync(Schema.toCodecJson(AppPairingPoll));

export type PairingRequest = AppPairingRequestCreated;
export type PairingPoll = AppPairingPoll;

async function failure(action: string, response: Response) {
  const text = await response.text().catch(() => "");
  return new Error(`${action}: ${response.status}${text ? ` ${text.slice(0, 512)}` : ""}`);
}

/** Asks the user's server to let the app in; the user answers in Lecturn. */
export async function createPairingRequest(
  origin: string,
  registration: AppRegistration,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PairingRequest> {
  const response = await fetchImpl(new URL(APPS_PAIRING_REQUESTS_PATH, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeRegistration(registration)),
    credentials: "omit",
  });
  if (!response.ok) throw await failure("Lecturn refused the pairing request", response);
  return decodeCreated(await response.json());
}

/** The credential is in the first answer after the grant, and in no later one. */
export async function pollPairingRequest(
  origin: string,
  request: Pick<PairingRequest, "requestId" | "pollSecret">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PairingPoll> {
  const response = await fetchImpl(new URL(appsPairingRequestPath(request.requestId), origin), {
    headers: { [APPS_POLL_SECRET_HEADER]: request.pollSecret },
    credentials: "omit",
  });
  if (!response.ok) throw await failure("Lecturn refused the pairing poll", response);
  return decodePoll(await response.json());
}
