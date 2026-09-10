import { CreditCardIcon, Link2Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { BillingAccount } from "./BillingAccount";

export function BillingSettingsDialog({
  open,
  onOpenChange,
  onConnections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnections?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="lecturn-settings-surface h-[min(760px,85dvh)] max-w-4xl overflow-hidden bg-background"
        bottomStickOnMobile={false}
      >
        <DialogTitle className="sr-only">Account settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your Lecturn Connect subscription and payment settings.
        </DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="lecturn-celestial-sidebar shrink-0 border-b bg-sidebar/70 p-4 sm:w-52 sm:border-e sm:border-b-0 sm:p-5">
            <p className="mb-4 pe-8 font-heading text-lg font-semibold">Account settings</p>
            <nav aria-label="Account settings" className="flex gap-2 sm:flex-col">
              <div
                aria-current="page"
                className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm font-medium"
              >
                <CreditCardIcon className="size-4" />
                Billing
              </div>
              <button
                type="button"
                data-lecturn-hover
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  if (onConnections) onConnections();
                  else {
                    onOpenChange(false);
                    void navigate({ to: "/settings/connections" });
                  }
                }}
              >
                <Link2Icon className="size-4" />
                Connections
              </button>
            </nav>
            <p className="mt-8 hidden text-xs leading-relaxed text-muted-foreground sm:block">
              Your workspace stays yours. Connect brings it with you.
            </p>
          </aside>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain sm:pt-3">
            <BillingAccount embedded />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function BillingSettingsMenuItem() {
  const [open, setOpen] = useState(false);
  if (!hasCloudPublicConfig()) return null;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => setOpen(true)}>
          <CreditCardIcon />
          <span>Billing</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <BillingSettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
