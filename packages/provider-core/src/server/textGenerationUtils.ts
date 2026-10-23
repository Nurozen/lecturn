import { TextGenerationError } from "@lecturn/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Codex accepts a subset of JSON Schema; application decoding remains authoritative. */
export function toCodexJsonSchemaObject(schema: Schema.Top): unknown {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!Predicate.isObject(value)) return value;
    // Effect represents non-finite numbers as strings in its JSON encoding. They
    // are never useful model output and finite-number schemas reject them locally.
    const variants = value.anyOf;
    if (Array.isArray(variants) && variants.length === 2) {
      const nonFinite = variants.find(
        (variant) =>
          Predicate.isObject(variant) &&
          variant.type === "string" &&
          Array.isArray(variant.enum) &&
          variant.enum.length === 3 &&
          variant.enum.every((item) => ["Infinity", "-Infinity", "NaN"].includes(item)),
      );
      if (nonFinite) return convert(variants.find((variant) => variant !== nonFinite));
    }
    // Refinements can introduce allOf (for example Number.between) and string
    // length bounds (toJsonSchemaObject emits the decoded type). These remain
    // enforced by the original Effect schema after receiving the final output.
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "allOf",
              "minLength",
              "maxLength",
              "not",
              "if",
              "then",
              "else",
              "dependentRequired",
              "dependentSchemas",
            ].includes(key),
        )
        .map(([key, item]) => {
          if (
            ["properties", "$defs", "definitions", "patternProperties"].includes(key) &&
            Predicate.isObject(item)
          ) {
            return [
              key,
              Object.fromEntries(
                Object.entries(item).map(([name, child]) => [name, convert(child)]),
              ),
            ];
          }
          if (["anyOf", "oneOf", "items", "prefixItems", "additionalProperties"].includes(key)) {
            return [key, convert(item)];
          }
          return [key, item];
        }),
    );
  };
  return convert(toJsonSchemaObject(schema));
}

/** Auxiliary inference errors must never retain process output, prompts or nested causes. */
export function privateTextGenerationError(operation: string, detail: string): TextGenerationError {
  return new TextGenerationError({ operation, detail });
}

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const MAX_THREAD_TITLE_CHARS = 120;

export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`;
}

function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (
    operation === "generateWorkflowSummary" ||
    operation === "generateContextualSummary" ||
    operation === "generateDecisionNotes"
  ) {
    return privateTextGenerationError(operation, fallback);
  }
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
