import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { LecturnProjectFile, LECTURN_PROJECT_FILE_SCHEMA_URL } from "@lecturn/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `lecturn.json` file contents (lenient JSONC string) and the
 * decoded {@link LecturnProjectFile}.
 */
export const LecturnProjectFileFromJson = fromLenientJson(LecturnProjectFile);

const decodeLecturnProjectFile = Schema.decodeExit(LecturnProjectFileFromJson);

/**
 * Decode raw `lecturn.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseLecturnProjectFile(contents: string): LecturnProjectFile | null {
  const decoded = decodeLecturnProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `lecturn.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link LECTURN_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildLecturnProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(LecturnProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: LECTURN_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
