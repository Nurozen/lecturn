import type {
  BackgroundScope,
  ChatAttachment,
  ServerSettings,
  ServerSettingsError,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderCredentialError } from "./errors.ts";

export interface ProviderHostPaths {
  readonly cwd: string;
  /** Lecturn home. */
  readonly baseDir: string;
  /** Server-owned state directory under the Lecturn home. */
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

export type ShellEnvironmentStatus = "pending" | "ready" | "timed-out" | "error";

export interface ShellEnvironmentResult {
  readonly status: "ready" | "timed-out" | "error";
  readonly message?: string;
}

export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "lecturn"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

export class ProviderHost extends Context.Service<
  ProviderHost,
  {
    readonly paths: ProviderHostPaths;
    readonly settings: {
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
      /** Runs `use` on a settings snapshot that no settings write can change until it finishes. */
      readonly withSnapshot: <A, E, R>(
        use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | ServerSettingsError, R>;
      readonly changes: Stream.Stream<ServerSettings>;
      /** Changes buffered from the moment the scoped subscription is acquired. */
      readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    };
    readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    /**
     * Absolute path of a stored chat attachment, or `null` when its id does not
     * resolve inside the attachments directory.
     */
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly credentials: (
      namespace: string,
      bindingId: string,
    ) => Effect.Effect<ProviderCredentials>;
    /**
     * The login-shell environment the server loads once at startup and shares
     * with every provider, so executables on the user's PATH resolve.
     */
    readonly shellEnvironment: {
      /** Current detection state, without waiting. */
      readonly status: () => ShellEnvironmentStatus;
      /** Waits for detection; `retry` restarts a probe that failed or timed out. */
      readonly await: (options?: {
        readonly retry?: boolean;
      }) => Effect.Effect<ShellEnvironmentResult>;
    };
  }
>()("@lecturn/provider-core/server/ProviderHost") {}
