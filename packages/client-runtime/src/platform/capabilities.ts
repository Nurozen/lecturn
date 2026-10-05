import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    /** Signed-in Connect accounts, primary account first. */
    readonly accountIds: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Accounts this client holds data for, signed in or waiting for sign-in.
     * A platform that keeps no such list leaves it out.
     */
    readonly knownAccountIds?: Effect.Effect<ReadonlyArray<string>>;
    /**
     * True once the platform has loaded its sign-in state and applied it to the
     * lists above. From then on a relay target whose owner is not signed in is
     * blocked instead of connecting from cache. Left out, nothing is blocked.
     */
    readonly accountsSynced?: Effect.Effect<boolean>;
    readonly clerkToken: (accountId: string) => Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@lecturn/client-runtime/platform/capabilities/CloudSession") {}

/** Known accounts, which are the signed-in ones where the platform keeps no list. */
export const knownAccountIds = (
  session: CloudSession["Service"],
): Effect.Effect<ReadonlyArray<string>> => session.knownAccountIds ?? session.accountIds;

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@lecturn/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@lecturn/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@lecturn/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@lecturn/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
