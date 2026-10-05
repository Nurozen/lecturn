import { Effect } from "effect";
import type { ExtensionFeatureId } from "@lecturn/contracts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { RelayDb } from "../db.ts";
import {
  decisionError,
  makeDecisionsAccess,
  type DecisionAccessSnapshot,
} from "../decisions/DecisionsAccess.ts";
import { makeDecisionFundingStore } from "../decisions/DecisionFundingStore.ts";
import { makeExtensionsUsageStore } from "../decisions/DecisionUsageStore.ts";
import type { ExtensionsConfig } from "./ExtensionsConfig.ts";

/** Feature consent is independent; accounting remains in the existing shared payer ledger. */
export const makeExtensionsFundingStore = (config: ExtensionsConfig, approvalOrigin: string) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const feature = (featureId: ExtensionFeatureId) =>
      Effect.gen(function* () {
        const featureConfig = { ...config.shared, ...config[featureId], featureId };
        const paidAccess = yield* makeDecisionsAccess(featureConfig);
        // Decisions remains compatible with phase 0; new feature consent requires promotion.
        const ready =
          featureId === "decisions"
            ? Effect.succeed(true)
            : sql<{ phase: number }>`SELECT phase FROM relay_extensions_schema WHERE id=1`.pipe(
                Effect.map((rows) => rows[0]?.phase === 1),
                Effect.orElseSucceed(() => false),
              );
        const requireReady = Effect.fn("ExtensionsFunding.requireReady")(function* () {
          if (!(yield* ready))
            return yield* decisionError("unavailable", "This extension is not ready yet");
        });
        const access = {
          status: Effect.fn("ExtensionsFunding.accessStatus")(function* (
            payerId: string,
          ): Effect.fn.Return<
            DecisionAccessSnapshot,
            import("@lecturn/contracts").DecisionEvaluationError
          > {
            if (!(yield* ready))
              return {
                enabled: featureConfig.enabled,
                eligible: false,
                reason: "unavailable",
                window: null,
                limitInputTokens: featureConfig.monthlyInputTokens,
              };
            return yield* paidAccess.status(payerId);
          }),
        };
        const funding = yield* makeDecisionFundingStore(access, { approvalOrigin, featureId });
        const usage = yield* makeExtensionsUsageStore(featureConfig);
        const status = Effect.fn("ExtensionsFunding.status")(function* (
          host: EnvironmentCredentialPrincipal,
        ) {
          const result = yield* funding.status(host);
          if (!(yield* ready))
            return {
              ...result,
              featureId,
              eligible: false,
              reason: "unavailable" as const,
              allowance: null,
            };
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
          if (!(yield* ready))
            return {
              ...result,
              featureId,
              eligible: false,
              reason: "unavailable" as const,
              allowance: null,
            };
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
          requireFunding: Effect.fn("ExtensionsFunding.requireFunding")(function* (
            host: EnvironmentCredentialPrincipal,
            generation: number,
          ) {
            yield* requireReady();
            return yield* funding.requireFunding(host, generation);
          }),
          challenge: Effect.fn("ExtensionsFunding.challenge")(function* (
            host: EnvironmentCredentialPrincipal,
            generation: number,
          ) {
            yield* requireReady();
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
            yield* requireReady();
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
            yield* requireReady();
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
