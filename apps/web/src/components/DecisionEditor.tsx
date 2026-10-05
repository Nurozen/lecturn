import { useState } from "react";
import type { ThreadDecision } from "@lecturn/contracts";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";

export function DecisionEditor({
  note,
  mode,
  busy,
  onSave,
  onClose,
}: {
  note: ThreadDecision;
  mode: "edit" | "comment";
  busy: boolean;
  onSave: (value: {
    title: string;
    body: string;
    rationale: string | null;
    comment: string | null;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(note.title),
    [body, setBody] = useState(note.body),
    [rationale, setRationale] = useState(note.rationale ?? ""),
    [comment, setComment] = useState(note.comment ?? "");
  const cls = "mt-1 w-full rounded-md border border-border bg-background p-2 text-sm";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? "Edit decision" : "Personal comment"}</DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Editing preserves source evidence and does not confirm the decision."
              : "Comments stay separate from the generated note."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onSave({
                title,
                body,
                rationale: rationale.trim() ? rationale : null,
                comment: comment.trim() ? comment : null,
              }).then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            {mode === "edit" ? (
              <>
                <label className="block text-sm">
                  Title
                  <input
                    autoFocus
                    className={cls}
                    maxLength={160}
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Decision
                  <textarea
                    className={cls}
                    rows={5}
                    maxLength={4000}
                    required
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Rationale
                  <textarea
                    className={cls}
                    rows={3}
                    maxLength={2000}
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="block text-sm">
                Comment
                <textarea
                  autoFocus
                  className={cls}
                  rows={6}
                  maxLength={8000}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim() || !body.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
