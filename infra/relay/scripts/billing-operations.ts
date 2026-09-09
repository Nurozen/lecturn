#!/usr/bin/env node
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";
import { RelayDb } from "../src/db.ts";
import { BillingError, makeBillingStore } from "../src/billing/BillingStore.ts";
import { makePaymentReviews } from "../src/billing/PaymentReviews.ts";
import { makeBillingGrantOperations } from "../src/billing/BillingGrants.ts";
import { makeBillingOperations } from "../src/billing/BillingOperations.ts";

export type BillingOperation =
  | { readonly command: "status" }
  | { readonly command: "payment-reviews" }
  | {
      readonly command: "resolve-review";
      readonly invoiceId: string;
      readonly operator: string;
      readonly reason: string;
    }
  | { readonly command: "inventory"; readonly after: string }
  | {
      readonly command: "grant";
      readonly userId: string;
      readonly id: string;
      readonly operator: string;
      readonly reason: string;
      readonly start: number;
      readonly end: number;
      readonly limit: number;
    }
  | {
      readonly command: "revoke-grant";
      readonly userId: string;
      readonly grantId: string;
      readonly id: string;
      readonly operator: string;
      readonly reason: string;
    }
  | { readonly command: "replay"; readonly eventId: string; readonly reason: string }
  | { readonly command: "prune"; readonly reason: string }
  | { readonly command: "suspension-control"; readonly enabled: boolean; readonly reason: string };

export function parseBillingOperation(args: readonly string[]): BillingOperation {
  if (args.length === 0 || (args.length === 1 && args[0] === "status"))
    return { command: "status" };
  const [command, ...options] = args;
  if (command === "payment-reviews" && options.length === 0) return { command };
  if (command === "resolve-review") {
    if (options.length !== 6)
      throw new Error("Resolve review requires --invoice --operator --reason");
    const values = new Map<string, string>();
    for (let i = 0; i < options.length; i += 2) {
      const name = options[i]!;
      if (!["--invoice", "--operator", "--reason"].includes(name) || values.has(name))
        throw new Error("Invalid review options");
      values.set(name, options[i + 1]!);
    }
    const invoiceId = values.get("--invoice");
    const operator = values.get("--operator");
    const reason = values.get("--reason");
    if (
      !invoiceId?.trim() ||
      !operator?.trim() ||
      operator.length > 200 ||
      !reason ||
      reason.trim().length < 8 ||
      reason.length > 1000
    )
      throw new Error("Invoice, operator and resolution reason are required");
    return { command, invoiceId, operator, reason };
  }

  if (
    command === "inventory" &&
    (options.length === 0 || (options.length === 2 && options[0] === "--after"))
  )
    return { command, after: options[1] ?? "" };
  if (command === "grant" || command === "revoke-grant") {
    const userId = options[0];
    const values = new Map<string, string>();
    if (!userId || userId.startsWith("--") || options.length % 2 !== 1)
      throw new Error("Invalid grant arguments");
    for (let i = 1; i < options.length; i += 2) {
      const name = options[i]!;
      const value = options[i + 1]!;
      if (values.has(name)) throw new Error("Duplicate grant option");
      values.set(name, value);
    }
    const allowed =
      command === "grant"
        ? ["--id", "--operator", "--reason", "--start", "--days", "--limit"]
        : ["--id", "--operator", "--reason", "--grant-id"];
    if ([...values.keys()].some((key) => !allowed.includes(key)))
      throw new Error("Unknown grant option");
    const id = values.get("--id");
    const operator = values.get("--operator");
    const reason = values.get("--reason");
    if (!id || !operator?.trim() || !reason || reason.trim().length < 8 || reason.length > 500)
      throw new Error("Grant writes require stable operation ID, operator and audit reason");
    if (command === "revoke-grant") {
      const grantId = values.get("--grant-id");
      if (!grantId) throw new Error("A grant ID is required");
      return { command, userId, grantId, id, operator, reason };
    }
    const start = Number(values.get("--start"));
    const days = Number(values.get("--days") ?? "30");
    const limit = Number(values.get("--limit") ?? "3");
    const end = start + days * 86400;
    if (
      !Number.isSafeInteger(start) ||
      start <= 0 ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days > 366 ||
      !Number.isSafeInteger(limit) ||
      limit < 3 ||
      limit > 10000 ||
      !Number.isSafeInteger(end)
    )
      throw new Error(
        "Grant start must be Unix seconds, days 1 through 366, and limit 3 through 10000",
      );
    return { command, userId, id, operator, reason, start, end, limit };
  }
  const reasonIndex = options.indexOf("--reason");
  const reason = options[reasonIndex + 1];
  if (reasonIndex < 0 || !reason || reason.trim().length < 8 || reason.length > 500)
    throw new Error("Writes require --reason with 8 through 500 characters");
  if (command === "replay" && options.length === 3 && reasonIndex === 1 && options[0]?.length)
    return { command, eventId: options[0], reason };
  if (
    command === "suspension-control" &&
    options.length === 3 &&
    reasonIndex === 1 &&
    ["on", "off"].includes(options[0]!)
  )
    return { command, enabled: options[0] === "on", reason };
  if (command === "prune" && options.length === 2 && reasonIndex === 0) return { command, reason };
  throw new Error(
    "Usage: billing-operations.ts [status | replay EVENT_ID --reason REASON | prune --reason REASON]",
  );
}

export const runBillingOperation = (operation: BillingOperation) =>
  Effect.gen(function* () {
    const store = yield* makeBillingStore;
    const operations = yield* makeBillingOperations({
      store,
      identity: () =>
        Effect.fail(
          new BillingError({
            code: "disabled",
            message: "Identity scan is not available in this command",
          }),
        ),
    });
    switch (operation.command) {
      case "payment-reviews":
        return yield* (yield* makePaymentReviews).pending();
      case "resolve-review":
        return yield* (yield* makePaymentReviews).resolve({
          invoiceId: operation.invoiceId,
          operator: operation.operator,
          resolution: operation.reason,
        });

      case "inventory":
        return yield* (yield* makeBillingGrantOperations).inventory(operation.after);
      case "grant":
        return yield* (yield* makeBillingGrantOperations).grant(operation.userId, operation);
      case "revoke-grant":
        return yield* (yield* makeBillingGrantOperations).revoke({
          userId: operation.userId,
          grantId: operation.grantId,
          operationId: operation.id,
          operator: operation.operator,
          reason: operation.reason,
        });
      case "status":
        return yield* operations.health();
      case "replay":
        return yield* operations.replay(operation.eventId, operation.reason);
      case "suspension-control":
        return yield* operations.suspensionControl(operation.enabled, operation.reason);
      case "prune":
        return yield* operations.pruneProcessedInbox({ enabled: true, reason: operation.reason });
    }
  });

if (import.meta.main) {
  try {
    const operation = parseBillingOperation(process.argv.slice(2));
    const url = process.env.BILLING_OPERATIONS_DATABASE_URL;
    if (!url)
      throw new Error(
        "Set BILLING_OPERATIONS_DATABASE_URL explicitly for the intended database branch",
      );
    const database = Layer.effect(
      RelayDb,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return { $client: sql } as RelayDb["Service"];
      }),
    ).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })));
    const result = await Effect.runPromise(
      runBillingOperation(operation).pipe(Effect.provide(database)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // SQL/connection errors can carry credentials. Keep the terminal failure deliberately bounded.
    process.stderr.write(
      "Billing operation failed. Check command arguments, selected database credentials and applied migrations.\n",
    );
    process.exitCode = 1;
  }
}
