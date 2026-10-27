// @effect-diagnostics preferSchemaOverJson:off
/**
 * The scripted test provider's step grammar. A turn's script is
 * a fenced `scripted` JSON block in its user message, or the entry for its
 * run ordinal in the file `LECTURN_SCRIPTED_PROVIDER_SCRIPTS` names.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const SaveName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][\w-]*$/u));

export const ScriptedToolCall = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ScriptedToolCall = typeof ScriptedToolCall.Type;

export const ScriptedStep = Schema.Union([
  Schema.Struct({ toolCall: ScriptedToolCall, saveAs: Schema.optionalKey(SaveName) }),
  Schema.Struct({ assistantText: Schema.String }),
  Schema.Struct({ expectApproval: Schema.Literal(true) }),
  Schema.Struct({
    poll: Schema.Struct({
      toolCall: ScriptedToolCall,
      until: Schema.Struct({ path: Schema.String, equals: Schema.Unknown }),
      maxTries: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      ),
      intervalMs: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
      ),
    }),
    saveAs: Schema.optionalKey(SaveName),
  }),
  Schema.Struct({
    hold: Schema.Union([Schema.Literal(true), Schema.Struct({ until: Schema.String })]),
  }),
]);
export type ScriptedStep = typeof ScriptedStep.Type;

export const ScriptedScript = Schema.Array(ScriptedStep);
export type ScriptedScript = typeof ScriptedScript.Type;

const ScriptedScriptFile = Schema.Union([
  Schema.Array(ScriptedScript),
  Schema.Record(Schema.String, ScriptedScript),
]);

export class ScriptedScriptError extends Schema.TaggedError<ScriptedScriptError>()(
  "ScriptedScriptError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Scripted provider: ${this.detail}`;
  }
}

const decodeScript = Schema.decodeUnknownExit(ScriptedScript);
const decodeScriptFile = Schema.decodeUnknownExit(ScriptedScriptFile);

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ScriptedScriptError({
      detail: `${source} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    });
  }
}

const FENCE = /```scripted[^\S\n]*\r?\n([\s\S]*?)```/gu;

/**
 * The script in the last fenced `scripted` block, or undefined when the text
 * has none. The last: a thread's first turn after a copy or fork carries the
 * earlier history ahead of the user's own message, scripts included.
 */
export function scriptFromMessage(text: string): ScriptedScript | undefined {
  const match = [...text.matchAll(FENCE)].at(-1);
  if (match === undefined) return undefined;
  const decoded = decodeScript(parseJson(match[1]!, "The scripted block"));
  if (Exit.isFailure(decoded)) {
    throw new ScriptedScriptError({
      detail: `invalid scripted block: ${Cause.pretty(decoded.cause)}`,
    });
  }
  return decoded.value;
}

/**
 * Picks the script for a 1-based turn index from a scripts file: an array
 * (index 0 is turn 1) or an object keyed by the turn index.
 */
export function scriptFromFile(text: string, turnIndex: number): ScriptedScript | undefined {
  const decoded = decodeScriptFile(parseJson(text, "The scripts file"));
  if (Exit.isFailure(decoded)) {
    throw new ScriptedScriptError({
      detail: `invalid scripts file: ${Cause.pretty(decoded.cause)}`,
    });
  }
  const scripts = decoded.value;
  return Array.isArray(scripts)
    ? (scripts as ReadonlyArray<ScriptedScript>)[turnIndex - 1]
    : (scripts as Readonly<Record<string, ScriptedScript>>)[String(turnIndex)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MISSING = Symbol("missing");

function lookup(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter((part) => part.length > 0)) {
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = Number(segment) < current.length ? current[Number(segment)] : MISSING;
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return MISSING;
    }
    if (current === MISSING) return MISSING;
  }
  return current;
}

/** The value at a dot path (`a.b.0`); an empty path is the value itself. */
export function readPath(
  value: unknown,
  path: string,
): { readonly found: boolean; readonly value?: unknown } {
  const found = lookup(value, path);
  return found === MISSING ? { found: false } : { found: true, value: found };
}

const PLACEHOLDER = /\$\{([A-Za-z_][\w-]*)((?:\.[\w-]+)*)\}/gu;
const WHOLE_PLACEHOLDER = /^\$\{([A-Za-z_][\w-]*)((?:\.[\w-]+)*)\}$/u;

function resolvePlaceholder(
  saved: ReadonlyMap<string, unknown>,
  name: string,
  path: string,
): unknown {
  if (!saved.has(name)) {
    throw new ScriptedScriptError({ detail: `\${${name}${path}} names no saved result` });
  }
  const found = lookup(saved.get(name), path);
  if (found === MISSING) {
    throw new ScriptedScriptError({
      detail: `\${${name}${path}}: path ${path.slice(1)} is not in the saved result`,
    });
  }
  return found;
}

/**
 * Replaces `${name.path}` in every string of `value`. A string that is only
 * one placeholder takes the saved value with its JSON type; otherwise the
 * value is spliced in as text.
 */
export function substitute(value: unknown, saved: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole !== null) return resolvePlaceholder(saved, whole[1]!, whole[2]!);
    return value.replace(PLACEHOLDER, (_match, name: string, path: string) => {
      const resolved = resolvePlaceholder(saved, name, path);
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, saved));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, saved)]),
    );
  }
  return value;
}

export interface ScriptedToolResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

/**
 * What `saveAs` and `poll.until` read: the structured content when the tool
 * returns it, else the single text block parsed as JSON, else the result.
 */
export function savedToolValue(result: ScriptedToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const only = content.length === 1 ? content[0] : undefined;
  if (isRecord(only) && only.type === "text" && typeof only.text === "string") {
    try {
      return JSON.parse(only.text);
    } catch {
      return result;
    }
  }
  return result;
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
    );
  }
  return false;
}

/** The text of a tool error result, for failure messages. */
export function toolResultText(result: ScriptedToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .flatMap((entry) => (isRecord(entry) && typeof entry.text === "string" ? [entry.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : "the tool returned an error";
}
