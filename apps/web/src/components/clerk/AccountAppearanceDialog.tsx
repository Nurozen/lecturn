import { useClerk } from "@clerk/react";
import {
  ACCOUNT_TINT_PRESETS,
  accountTintColor,
  readAccountAppearance,
  type AccountTintPresetId,
} from "@lecturn/shared/accountTint";
import { useState } from "react";
import { saveAccountAppearance } from "../../cloud/accountAppearance";
import type { ConnectAccountProfile } from "../../cloud/connectAccounts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** A keyed dialog keeps the draft local until its account's metadata write succeeds. */
export function AccountAppearanceDialog({
  accountId,
  profile,
  onClose,
}: {
  readonly accountId: string;
  readonly profile: ConnectAccountProfile | undefined;
  readonly onClose: () => void;
}) {
  const clerk = useClerk();
  const initial = readAccountAppearance({ lecturn: profile }, profile?.email);
  const [label, setLabel] = useState(initial.label);
  const [preset, setPreset] = useState<AccountTintPresetId>(initial.preset);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveAccountAppearance(clerk, accountId, { label, preset });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the account appearance.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="w-full sm:max-w-sm" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Account appearance</DialogTitle>
          <DialogDescription>
            {profile?.email ?? "Connect account"} · Synced across your devices.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            Label
            <Input
              autoFocus
              maxLength={40}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={saving}
            />
          </label>
          <fieldset disabled={saving}>
            <legend className="mb-2 text-sm">Color</legend>
            <div className="grid grid-cols-3 gap-2">
              {ACCOUNT_TINT_PRESETS.map((entry) => (
                <label
                  key={entry.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border p-2 text-xs has-checked:ring-2 has-checked:ring-ring has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
                >
                  <input
                    type="radio"
                    name="account-preset"
                    value={entry.id}
                    checked={preset === entry.id}
                    onChange={() => setPreset(entry.id)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className="size-3 rounded-full"
                    style={{ backgroundColor: accountTintColor(entry.id) }}
                  />
                  {entry.label}
                </label>
              ))}
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-error-foreground">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !label.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
