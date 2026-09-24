import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { useAuth } from "@clerk/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { selectTeam, type TeamDetail, type TeamSeatPreview } from "@lecturn/client-runtime/relay";
import { configuredHostedAppUrl, isHostedStaticApp } from "../../hostedPairing";
import { Button } from "../ui/button";
import { hostedBillingUrl } from "../../cloud/accountPicker";
import type { PickedConnectAccount } from "../clerk/ConnectAccountPicker";
import { TeamSelector, useSelectedTeam, useTeamClient } from "./TeamSelector";

const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground";
/**
 * `account` is the dialog's chosen account. Without a choice,
 * teams follow Clerk's active account.
 */
export function TeamsAccount({ account }: { readonly account?: PickedConnectAccount }) {
  const chosen = account?.visible ? account : null;
  // Keyed by a chosen account, so one account's team is never shown under another's name.
  const key = chosen ? (chosen.accountId ?? "signed-out") : undefined;
  if (isHostedStaticApp())
    return (
      <HostedTeamsAccount key={key} accountId={chosen?.accountId} picker={chosen?.picker ?? null} />
    );
  return (
    <section className="space-y-5 p-6">
      <h2 className="font-heading text-2xl">Lecturn Teams</h2>
      {chosen?.picker}
      <TeamSelector key={key} accountId={chosen?.accountId} />
      <p className="text-sm text-muted-foreground">
        Choose company access here. Manage your company, members, seats and policies in the hosted
        Lecturn web app.
      </p>
      <a
        className="inline-flex rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-foreground"
        href={hostedBillingUrl({
          hostedAppUrl: configuredHostedAppUrl(),
          tab: "teams",
          accountId: chosen?.accountId,
        })}
        target="_blank"
        rel="noopener noreferrer"
      >
        Manage Teams in browser
      </a>
      <p className="text-sm text-muted-foreground">
        {chosen?.email
          ? `Use ${chosen.email} in your browser.`
          : "Use the same Lecturn account in your browser."}
      </p>
    </section>
  );
}

function HostedTeamsAccount({
  accountId,
  picker,
}: {
  /** undefined follows Clerk's active account. */
  readonly accountId: string | null | undefined;
  readonly picker: ReactNode;
}) {
  const auth = useAuth();
  const userId = accountId === undefined ? auth.userId : accountId;
  const isSignedIn =
    accountId === undefined || accountId === auth.userId ? auth.isSignedIn : accountId !== null;
  const client = useTeamClient(accountId);
  const organizationId = useSelectedTeam(accountId);
  const context = `${userId}:${organizationId}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  const [detail, setDetail] = useState<{ context: string; value: TeamDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [seats, setSeats] = useState(5);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [preview, setPreview] = useState<TeamSeatPreview | null>(null);
  const [providers, setProviders] = useState<readonly string[] | null>(null);
  const [publish, setPublish] = useState(true);
  useEffect(() => {
    let disposed = false;
    setError(null);
    setPreview(null);
    if (organizationId)
      void client.detail(organizationId).then(
        (value) => {
          if (disposed) return;
          setDetail({ context, value });
          setSeats(Math.max(5, value.organization.purchasedSeats));
          setInterval(value.billing?.interval ?? "month");
          setProviders(value.organization.policy.allowedProviders);
          setPublish(value.organization.policy.publishAgentActivity);
        },
        (cause: unknown) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load team.");
        },
      );
    return () => {
      disposed = true;
    };
  }, [client, context, organizationId, version]);
  const data = detail?.context === context ? detail.value : null;
  async function run(action: () => Promise<unknown>, refresh = true) {
    if (busy) return;
    const expected = context;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (refresh && currentContext.current === expected) setVersion((value) => value + 1);
    } catch (cause) {
      if (currentContext.current === expected)
        setError(cause instanceof Error ? cause.message : "Could not complete action.");
    } finally {
      setBusy(false);
    }
  }
  if (!isSignedIn || !userId) return <p className="p-6">Sign in to manage a team.</p>;
  const admin = data?.organization.role === "owner" || data?.organization.role === "admin";
  const owner = data?.organization.role === "owner";
  return (
    <div className="space-y-6 p-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-primary">Lecturn Teams</p>
        <h2 className="mt-2 font-heading text-2xl">One company. Your own workspace.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage seats centrally. Members retain private environments, projects and provider
          credentials.
        </p>
      </header>
      {picker}
      <TeamSelector key={`${userId}:${version}`} accountId={accountId} />
      <Button variant="outline" disabled={busy} onClick={() => setVersion((value) => value + 1)}>
        Refresh team status
      </Button>
      {new URLSearchParams(window.location.search).get("checkout") === "complete" && (
        <p role="status" className="text-sm text-muted-foreground">
          Checkout returned. Refresh team status while payment confirmation arrives. Seats become
          available after your payment is confirmed.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-6 disabled:opacity-70">
        {!organizationId ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await client.create(name.trim());
                const list = await client.list();
                const created = list.organizations.find((org) => org.name === name.trim());
                if (created && currentContext.current === context) {
                  selectTeam(userId, created.organizationId);
                  try {
                    localStorage.setItem(`lecturn.team.${userId}`, created.organizationId);
                  } catch {
                    /* Session-only selection. */
                  }
                }
              });
            }}
          >
            <h3 className="font-heading text-lg">Create your company</h3>
            <label className="block text-sm">
              Company name
              <input
                className={`${inputClass} mt-2`}
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Button type="submit">Create company</Button>
          </form>
        ) : !data ? (
          <p role="status">Loading team…</p>
        ) : (
          <>
            <section className="border-b pb-5">
              <h3 className="font-heading text-xl">{data.organization.name}</h3>
              <p className="mt-2 text-sm">
                {data.organization.assignedSeats} assigned / {data.organization.purchasedSeats}{" "}
                purchased seats ·{" "}
                {data.billing?.state ??
                  (data.organization.hasAccess ? "Access active" : "Access inactive")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Three managed environments per assigned seat. Invitations never purchase seats.
              </p>
            </section>
            {admin && (
              <section className="space-y-3">
                <h3 className="font-heading text-lg">Members</h3>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await client.invite(organizationId, email.trim(), "member");
                      setEmail("");
                    });
                  }}
                >
                  <input
                    aria-label="Invite email"
                    className={inputClass}
                    type="email"
                    required
                    placeholder="colleague@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <Button type="submit">Invite</Button>
                </form>
                {data.members.map((member) => (
                  <div
                    key={member.userId}
                    className="flex flex-col items-stretch gap-2 border-b py-3 sm:flex-row sm:flex-wrap sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{member.name || member.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {member.role} · {member.hasSeat ? "Seat assigned" : "No seat"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !member.hasSeat &&
                        data.organization.assignedSeats >= data.organization.purchasedSeats
                      }
                      onClick={() =>
                        void run(() => client.seat(organizationId, member.userId, !member.hasSeat))
                      }
                    >
                      {member.hasSeat ? "Revoke seat" : "Assign seat"}
                    </Button>
                    {member.role !== "owner" && (owner || member.role === "member") && (
                      <>
                        {owner && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void run(() =>
                                client.role(
                                  organizationId,
                                  member.userId,
                                  member.role === "admin" ? "member" : "admin",
                                ),
                              )
                            }
                          >
                            {member.role === "admin" ? "Make member" : "Make admin"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void run(() => client.removeMember(organizationId, member.userId))
                          }
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                ))}
                {data.invitations.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex flex-col items-stretch justify-between gap-2 text-sm sm:flex-row sm:items-center"
                  >
                    <span>{invite.email} · Invited</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void run(() => client.revokeInvitation(organizationId, invite.id))
                      }
                    >
                      Revoke invitation
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Revoking a seat or removing a member stops their company-funded Connect access
                  immediately. Personal access stays theirs.
                </p>
              </section>
            )}
            {owner && data.billing && (
              <section className="space-y-3">
                <h3 className="font-heading text-lg">Seats and billing</h3>
                <div className="flex gap-3">
                  <label className="flex-1 text-sm">
                    Purchased seats
                    <input
                      className={`${inputClass} mt-1`}
                      type="number"
                      min={Math.max(5, data.organization.assignedSeats)}
                      max={20}
                      step={1}
                      value={seats}
                      onChange={(event) => {
                        setSeats(Number(event.target.value));
                        setPreview(null);
                      }}
                    />
                  </label>
                  <label className="flex-1 text-sm">
                    Billing interval
                    {data.organization.purchasedSeats > 0 ? (
                      <span className="mt-1 block rounded-md border px-3 py-2">
                        {data.billing.interval === "year"
                          ? "Annually"
                          : data.billing.interval === "month"
                            ? "Monthly"
                            : "Not available"}
                      </span>
                    ) : (
                      <select
                        className={`${inputClass} mt-1`}
                        value={interval}
                        onChange={(event) =>
                          setInterval(event.target.value === "year" ? "year" : "month")
                        }
                      >
                        <option value="month">Monthly</option>
                        <option value="year">Annually</option>
                      </select>
                    )}
                  </label>
                </div>
                {data.organization.purchasedSeats === 0 ? (
                  <Button
                    disabled={!data.billing.checkoutEnabled}
                    onClick={() =>
                      void run(async () => {
                        const url = await client.checkout(organizationId, interval, seats);
                        if (currentContext.current === context) window.location.assign(url);
                      })
                    }
                  >
                    Continue to secure checkout
                  </Button>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        void run(async () => {
                          const value = await client.previewSeats(organizationId, seats);
                          if (currentContext.current === context) setPreview(value);
                        }, false)
                      }
                    >
                      {data.billing.pendingSeats !== null &&
                      seats === data.organization.purchasedSeats
                        ? "Keep current seats"
                        : "Preview seat change"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          const url = await client.portal(organizationId);
                          if (currentContext.current === context) window.location.assign(url);
                        })
                      }
                    >
                      Payment details and invoices
                    </Button>
                  </div>
                )}
                {preview && (
                  <div className="space-y-2 rounded-lg border border-primary/30 p-3">
                    <p className="text-sm">
                      Change to {preview.quantity} seats. Due now:{" "}
                      {new Intl.NumberFormat(undefined, {
                        style: "currency",
                        currency: preview.currency,
                      }).format(preview.amountDue / 100)}
                      .
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Effective {new Date(preview.effectiveAt * 1000).toLocaleDateString()}. New
                      capacity is available after payment confirmation; reductions apply at renewal.
                    </p>
                    <Button
                      onClick={() =>
                        void run(async () => {
                          await client.confirmSeats(organizationId, preview.id);
                          setPreview(null);
                        })
                      }
                    >
                      Confirm seat change
                    </Button>
                  </div>
                )}
                {data.billing.pendingSeats !== null && (
                  <p className="text-sm">
                    {data.billing.pendingSeats} seats scheduled for renewal.
                  </p>
                )}
              </section>
            )}
            {admin && (
              <section className="space-y-3">
                <h3 className="font-heading text-lg">Managed settings</h3>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">Allowed providers</legend>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={providers === null}
                      onChange={(event) =>
                        setProviders(
                          event.target.checked
                            ? null
                            : PROVIDER_CLIENT_DEFINITIONS.map((provider) => provider.value),
                        )
                      }
                    />
                    Allow all providers, including new providers
                  </label>
                  {providers !== null && (
                    <div className="grid grid-cols-2 gap-2">
                      {PROVIDER_CLIENT_DEFINITIONS.map((provider) => (
                        <label
                          key={provider.value}
                          className="flex min-h-9 items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={providers.includes(provider.value)}
                            onChange={(event) =>
                              setProviders(
                                event.target.checked
                                  ? [...providers, provider.value]
                                  : providers.filter((value) => value !== provider.value),
                              )
                            }
                          />
                          {provider.label}
                        </label>
                      ))}
                    </div>
                  )}
                  {providers?.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No providers will be allowed on company-funded environments.
                    </p>
                  )}
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={publish}
                    onChange={(event) => setPublish(event.target.checked)}
                  />
                  Allow company environments to publish agent activity
                </label>
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(() =>
                      client.policy(organizationId, {
                        allowedProviders: providers,
                        publishAgentActivity: publish,
                      }),
                    )
                  }
                >
                  Save policy
                </Button>
              </section>
            )}
            {admin && (
              <section className="space-y-3">
                <h3 className="font-heading text-lg">Environment inventory</h3>
                {data.environments.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No company-funded environments yet.
                  </p>
                )}
                {data.environments.map((env) => (
                  <div key={env.environmentId} className="border-b py-2 text-sm">
                    <span>{env.name}</span>
                    <span className="float-right text-muted-foreground">{env.status}</span>
                    <p className="text-xs text-muted-foreground">
                      {data.members.find((member) => member.userId === env.userId)?.email ??
                        env.userId}
                    </p>
                  </div>
                ))}
              </section>
            )}
            {admin && (
              <section className="space-y-3">
                <h3 className="font-heading text-lg">Audit history</h3>
                {data.audit.length === 0 && (
                  <p className="text-sm text-muted-foreground">No recorded changes.</p>
                )}
                {data.audit.map((entry) => (
                  <div key={entry.id} className="border-b py-2 text-sm">
                    <p>{auditLabel(entry.action)}</p>
                    <p className="text-xs text-muted-foreground">
                      {data.members.find((member) => member.userId === entry.actorUserId)?.email ??
                        entry.actorUserId}{" "}
                      · {new Date(entry.createdAt * 1000).toLocaleString()}
                    </p>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </fieldset>
    </div>
  );
}

function auditLabel(action: string): string {
  const labels: Record<string, string> = {
    "seat.assigned": "Seat assigned",
    "seat.revoked": "Seat revoked",
    "environment.funded": "Environment linked to company",
    "environment.unfunded": "Company environment unlinked",
    "policy.updated": "Managed settings updated",
    "organization.created": "Company created",
    "member.invited": "Member invited",
    "invitation.revoked": "Invitation revoked",
    "role.admin": "Administrator role granted",
    "role.member": "Member role granted",
    "member.removed": "Member removed",
  };
  return labels[action] ?? "Team account updated";
}
