import { EnvironmentId } from "@lecturn/contracts";
import { type EnvironmentConnectionPhase } from "@lecturn/client-runtime/connection";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
  readonly relayManaged?: true;
  readonly accountId?: string;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;
