/**
 * A dedicated bold face (DMSans-Bold on Android) is already bold, so Enriched must not embolden it
 * again. Lecturn's iOS text uses the System family for every weight (`useFontFamily`), so there the
 * weight has to carry the bold.
 */
export function enrichedStrongFontWeight(style: {
  readonly fontFamily: string;
  readonly boldFontFamily: string;
}): "bold" | "normal" {
  return style.boldFontFamily.length > 0 && style.boldFontFamily !== style.fontFamily
    ? "normal"
    : "bold";
}
