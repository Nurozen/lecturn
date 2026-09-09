import type { BillingConfig } from "./BillingConfig.ts";

/** Deployment proofs authorize new gateway enrollment; existing direct tunnels never migrate implicitly. */
export function parseManagedGatewayConfig(
  env: Readonly<Record<string, string | undefined>>,
  billing: BillingConfig,
  stage: string,
) {
  const boolean = (name: string) => {
    if (env[name] !== undefined && env[name] !== "true" && env[name] !== "false")
      throw new Error(`${name} must be true or false`);
    return env[name] === "true";
  };
  const enabled = boolean("MANAGED_GATEWAY_ENABLED");
  const guardVerified = boolean("MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED");
  const routeVerified = boolean("MANAGED_GATEWAY_ROUTE_VERIFIED");
  const enforcementUsers = [...new Set(billing.enforcementUsers ?? [])];
  if (enabled) {
    if (stage.length > 36 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage))
      throw new Error(
        "Gateway requires an explicit DNS-safe deployment stage of at most 36 characters",
      );
    if (!billing.managedAccessEnabled || billing.mode === "disabled")
      throw new Error("Gateway requires managed-access enforcement or isolated sandbox testing");
    if (stage === "prod" ? !billing.livemode || billing.mode !== "enforce" : billing.livemode)
      throw new Error("Gateway billing mode must match its production or sandbox stage");
    if (
      enforcementUsers.length === 0 ||
      enforcementUsers.some((id) => id !== "*" && !/^user_[A-Za-z0-9]+$/.test(id))
    )
      throw new Error("Gateway requires an explicit reviewed BILLING_ENFORCEMENT_USERS cohort");
    if (!guardVerified || !routeVerified)
      throw new Error("Gateway requires verified origin blocking and public route coverage");
  }
  if (stage === "prod" && billing.mode === "enforce" && !enabled)
    throw new Error("Production paid enforcement requires the verified managed gateway");
  return { enabled, guardVerified, routeVerified, enforcementUsers };
}
