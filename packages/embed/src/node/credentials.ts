// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Promise API for hosts that run no Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

/** The bearer a user server hands a paired app, kept per environment. */
export interface StoredCredential {
  readonly token: string;
  readonly expiresAt: string;
}

export interface CredentialStore {
  get(environmentId: string): Promise<StoredCredential | null>;
  set(environmentId: string, credential: StoredCredential): Promise<void>;
  delete(environmentId: string): Promise<void>;
}

/** The slice of `@napi-rs/keyring`'s `AsyncEntry` the store uses. */
export interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

const StoredCredentialSchema = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeCredential = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCredentialSchema));
const decodeCredentialFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, StoredCredentialSchema)),
);

// A variable specifier keeps the bundler from resolving it: the keyring is the
// host's optional native dependency, not ours.
const KEYRING_MODULE = "@napi-rs/keyring";

/** The keyring when the host ships `@napi-rs/keyring`, else null. */
export async function loadKeyring(): Promise<KeyringEntryFactory | null> {
  try {
    const module = (await import(/* @vite-ignore */ KEYRING_MODULE)) as {
      readonly AsyncEntry?: new (service: string, account: string) => KeyringEntry;
    };
    const AsyncEntry = module.AsyncEntry;
    return AsyncEntry === undefined ? null : (service, account) => new AsyncEntry(service, account);
  } catch {
    return null;
  }
}

export const credentialFilePath = (baseDir: string) =>
  NodePath.join(baseDir, "embed-credentials.json");

function fileStore(path: string): CredentialStore {
  const readAll = async (): Promise<Record<string, StoredCredential>> => {
    try {
      const decoded = decodeCredentialFile(await NodeFSP.readFile(path, "utf8"));
      return decoded._tag === "Some" ? { ...decoded.value } : {};
    } catch {
      return {};
    }
  };
  // Every write replaces the file through a 0600 temp file, so the bearer is
  // never readable by other users, even for a moment.
  const writeAll = async (all: Record<string, StoredCredential>) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await NodeFSP.writeFile(temp, JSON.stringify(all), { mode: 0o600 });
    await NodeFSP.rename(temp, path);
  };
  return {
    get: async (environmentId) => (await readAll())[environmentId] ?? null,
    set: async (environmentId, credential) => {
      const all = await readAll();
      all[environmentId] = { token: credential.token, expiresAt: credential.expiresAt };
      await writeAll(all);
    },
    delete: async (environmentId) => {
      const all = await readAll();
      if (!(environmentId in all)) return;
      delete all[environmentId];
      await writeAll(all);
    },
  };
}

function keyringStore(entry: KeyringEntryFactory, appId: string): CredentialStore {
  const service = `lecturn-embed:${appId}`;
  return {
    get: async (environmentId) => {
      const raw = await entry(service, environmentId).getPassword();
      if (raw === undefined || raw === null) return null;
      const decoded = decodeCredential(raw);
      return decoded._tag === "Some" ? decoded.value : null;
    },
    set: async (environmentId, credential) => {
      await entry(service, environmentId).setPassword(
        JSON.stringify({ token: credential.token, expiresAt: credential.expiresAt }),
      );
    },
    delete: async (environmentId) => {
      await entry(service, environmentId).deleteCredential();
    },
  };
}

/**
 * The OS keyring when it is available, else a 0600 file in the sidecar's
 * baseDir. A keyring that loads but fails at runtime (no secret service on a
 * headless Linux box) falls back to the file for that call.
 */
export function makeCredentialStore(input: {
  readonly appId: string;
  readonly baseDir: string;
  readonly keyring: KeyringEntryFactory | null;
}): CredentialStore {
  const file = fileStore(credentialFilePath(input.baseDir));
  if (input.keyring === null) return file;
  const keyring = keyringStore(input.keyring, input.appId);
  return {
    get: (environmentId) =>
      keyring
        .get(environmentId)
        .catch(() => null)
        .then((found) => found ?? file.get(environmentId)),
    set: (environmentId, credential) =>
      keyring.set(environmentId, credential).catch(() => file.set(environmentId, credential)),
    delete: async (environmentId) => {
      await keyring.delete(environmentId).catch(() => undefined);
      await file.delete(environmentId);
    },
  };
}

/** Expired a minute early, so a reconnect never races the server's own expiry. */
export const isCredentialUsable = (credential: StoredCredential, now = Date.now()) => {
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - 60_000 > now;
};
