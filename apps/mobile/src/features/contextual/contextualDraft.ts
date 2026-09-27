import * as Schema from "effect/Schema";

export const ContextualDraftSchema = Schema.Struct({
  enabled: Schema.Boolean,
  sourceIds: Schema.Array(Schema.String).check(Schema.isMaxLength(256)),
});
export type ContextualDraft = typeof ContextualDraftSchema.Type;

/** Unknown/older hosts must never receive the additive bootstrap field. */
export function contextualBootstrap(supported: boolean, draft: ContextualDraft | undefined) {
  return supported && draft ? { contextual: draft } : {};
}
