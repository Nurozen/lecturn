import { readAccountAppearance, type AccountAppearance } from "@lecturn/shared/accountTint";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { observeAccountProfiles, type ObservedClerkUser } from "./connectAccounts";
import { connectMultiAccount } from "./publicConfig";
import { withActiveAccountForProfile } from "./withActiveAccount";

export interface AppearanceUser extends ObservedClerkUser {
  readonly updateMetadata: (params: {
    unsafeMetadata: Record<string, unknown>;
  }) => Promise<AppearanceUser>;
  readonly reload: () => Promise<AppearanceUser>;
}
export interface AppearanceClerk {
  readonly client?:
    | { readonly signedInSessions: ReadonlyArray<{ readonly user: AppearanceUser | null }> }
    | undefined;
}

const usersOf = (clerk: AppearanceClerk) =>
  (clerk.client?.signedInSessions ?? []).flatMap((session) => (session.user ? [session.user] : []));
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Writes /me only during this account's serialized active turn, and trusts no mismatched response. */
export async function saveAccountAppearance(
  clerk: AppearanceClerk,
  accountId: string,
  appearance: AccountAppearance,
): Promise<void> {
  if (!connectMultiAccount) return;
  await withActiveAccountForProfile(accountId, async () => {
    const user = usersOf(clerk).find((user) => user.id === accountId);
    if (!user) throw new Error("That account needs sign-in before its appearance can change.");
    const metadata = record(user.unsafeMetadata);
    const prefs = readAccountAppearance(
      { lecturn: appearance },
      user.primaryEmailAddress?.emailAddress,
    );
    const updated = await user.updateMetadata({
      unsafeMetadata: { ...metadata, lecturn: { ...record(metadata.lecturn), ...prefs } },
    });
    if (updated.id !== accountId)
      throw new Error("The account changed before its appearance was saved. Try again.");
    observeAccountProfiles(
      appAtomRegistry,
      usersOf(clerk).map((entry) => (entry.id === accountId ? updated : entry)),
    );
  });
}

let refresh: Promise<void> | null = null;
/** Reloads every signed-in profile on foreground/menu open; a failed account keeps its cached appearance. */
export function refreshAccountAppearance(clerk: AppearanceClerk): Promise<void> {
  if (!connectMultiAccount) return Promise.resolve();
  if (refresh) return refresh;
  refresh = (async () => {
    const reloaded: AppearanceUser[] = [];
    for (const user of usersOf(clerk)) {
      try {
        const next = await withActiveAccountForProfile(user.id, () => user.reload());
        if (next.id === user.id && usersOf(clerk).some((entry) => entry.id === next.id))
          reloaded.push(next);
      } catch {
        /* Offline accounts keep their last profile. */
      }
    }
    observeAccountProfiles(
      appAtomRegistry,
      usersOf(clerk).map((user) => reloaded.find((next) => next.id === user.id) ?? user),
    );
  })().finally(() => {
    refresh = null;
  });
  return refresh;
}

let initializationTurn: Promise<void> = Promise.resolve();
/** Persist defaults once an account joins; repeated session observations share each pending write. */
export function initializeAccountAppearance(clerk: AppearanceClerk): Promise<void> {
  if (!connectMultiAccount) return Promise.resolve();
  initializationTurn = initializationTurn
    .catch(() => undefined)
    .then(async () => {
      const users = usersOf(clerk);
      const used = users.flatMap((user) => {
        const preset = record(record(user.unsafeMetadata).lecturn).preset;
        return typeof preset === "string" ? [preset] : [];
      });
      for (const user of users) {
        const prefs = record(record(user.unsafeMetadata).lecturn);
        if (prefs.label !== undefined && prefs.preset !== undefined) continue;
        const appearance = readAccountAppearance(
          user.unsafeMetadata,
          user.primaryEmailAddress?.emailAddress,
          used,
        );
        used.push(appearance.preset);
        try {
          await saveAccountAppearance(clerk, user.id, appearance);
        } catch {
          /* A later foreground refresh retries defaults after connectivity returns. */
        }
      }
    });
  return initializationTurn;
}
