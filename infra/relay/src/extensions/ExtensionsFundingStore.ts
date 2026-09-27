import { Effect } from "effect";
import type { ExtensionFeatureId } from "@lecturn/contracts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { makeDecisionsAccess } from "../decisions/DecisionsAccess.ts";
import { makeDecisionFundingStore } from "../decisions/DecisionFundingStore.ts";
import { makeExtensionsUsageStore } from "../decisions/DecisionUsageStore.ts";
import type { ExtensionsConfig } from "./ExtensionsConfig.ts";

/** Feature consent is independent; accounting remains in the existing shared payer ledger. */
export const makeExtensionsFundingStore = (config: ExtensionsConfig, approvalOrigin: string) =>
  Effect.gen(function* () {
    const feature = (featureId: ExtensionFeatureId) =>
      Effect.gen(function* () {
        const featureConfig = { ...config.shared, ...config[featureId], featureId };
        const access = yield* makeDecisionsAccess(featureConfig);
        const funding = yield* makeDecisionFundingStore(access, { approvalOrigin, featureId });
        const usage = yield* makeExtensionsUsageStore(featureConfig);
        const status = Effect.fn("ExtensionsFunding.status")(function* (
          host: EnvironmentCredentialPrincipal,
        ) {
          const result = yield* funding.status(host);
          return {
            ...result,
            featureId,
            allowance: result.eligible
              ? yield* usage.getSharedAllowance(
                  (yield* funding.requireFunding(host, result.generation)).payerId,
                )
              : null,
          };
        });
        const statusByPayer = Effect.fn("ExtensionsFunding.statusByPayer")(function* (
          payerId: string,
          environmentId: string,
        ) {
          const result = yield* funding.statusByPayer(payerId, environmentId);
          return {
            ...result,
            featureId,
            allowance: result.eligible ? yield* usage.getSharedAllowance(payerId) : null,
          };
        });
        return {
          ...funding,
          access,
          usage,
          status,
          statusByPayer,
          challenge: Effect.fn("ExtensionsFunding.challenge")(function* (
            host: EnvironmentCredentialPrincipal,
            generation: number,
          ) {
            return {
              ...(yield* funding.challenge(host, generation)),
              featureId,
              environmentId: host.environmentId,
            };
          }),
          approvalInfo: Effect.fn("ExtensionsFunding.approvalInfo")(function* (
            payerId: string,
            challengeId: string,
          ) {
            const { approved: _approved, ...info } = yield* funding.approvalInfo(
              payerId,
              challengeId,
            );
            return { ...info, featureId };
          }),
          approve: Effect.fn("ExtensionsFunding.approve")(function* (
            payerId: string,
            challengeId: string,
            label: string,
          ) {
            const info = yield* funding.approvalInfo(payerId, challengeId);
            const result = yield* funding.approve(payerId, challengeId, label);
            return {
              featureId,
              challengeId,
              environmentId: info.environmentId,
              generation: info.generation,
              state: "approved-awaiting-host" as const,
              expiresAt: result.expiresAt,
            };
          }),
          redeem: Effect.fn("ExtensionsFunding.redeem")(function* (
            host: EnvironmentCredentialPrincipal,
            challengeId: string,
            generation: number,
          ) {
            yield* funding.redeem(host, challengeId, generation);
            return yield* status(host);
          }),
          revokeByHost: Effect.fn("ExtensionsFunding.revokeByHost")(function* (
            host: EnvironmentCredentialPrincipal,
            generation: number,
          ) {
            yield* funding.revokeByHost(host, generation);
            return yield* status(host);
          }),
          revokeByPayer: Effect.fn("ExtensionsFunding.revokeByPayer")(function* (
            payerId: string,
            environmentId: string,
            generation: number,
          ) {
            const result = yield* funding.revokeByPayer(payerId, environmentId, generation);
            return { ...result, featureId };
          }),
          listByPayer: Effect.fn("ExtensionsFunding.listByPayer")(function* (
            payerId: string,
            input: { readonly cursor?: string; readonly limit?: number },
          ) {
            const result = yield* funding.listByPayer(payerId, input);
            return {
              ...result,
              featureId,
              environments: result.environments.map((entry) => ({ ...entry, featureId })),
            };
          }),
        };
      });
    return { decisions: yield* feature("decisions"), contextual: yield* feature("contextual") };
  });
