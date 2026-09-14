/** Persisted infrastructure identifiers predate the Lecturn product name.
 * Renaming these creates a separate stack and rotates signing keys. All stages
 * share the stack identity so references to production resolve correctly.
 */
export const RELAY_STACK_NAME = "T3CodeRelay";
export const RELAY_PRODUCTION_DATABASE_NAME = "t3coderelay";

export const relayPhysicalName = (name: string, stage: string) =>
  stage === "prod" ? name.replace(/^lecturn-/, "t3-code-") : name;
