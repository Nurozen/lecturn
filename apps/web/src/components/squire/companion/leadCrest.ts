// The Lead's crest (OQ22): a guiding star over a gathered thread, simplified so the star stays
// apart from the thread at the 9 px indicator badge. Source of truth:
// artifacts/squire-concepts/v5/assets/logo/lead-crest.svg. One 24 x 24 geometry for the cloak
// crest and every indicator badge.
export const LEAD_CREST_VIEWBOX = 24;
export const LEAD_CREST_STAR = "M12 1 14.8 5.6 21 7.5 14.8 9.4 12 14 9.2 9.4 3 7.5 9.2 5.6Z";
export const LEAD_CREST_THREAD =
  "M3 16.3C7.8 14.7 8.1 19.5 12.1 18.2 15.4 17.1 17.8 15.2 21 17.6L19.5 20.1C17.5 18.5 15.7 20.2 12.8 21.2 7.4 23 6.8 18 3.5 19.2Z";
export const LEAD_CREST_PATHS = [LEAD_CREST_STAR, LEAD_CREST_THREAD] as const;
export const LEAD_CREST_FILL = "#f6d365";
export const LEAD_CREST_STROKE = "#684819";
export const LEAD_CREST_STROKE_WIDTH = 0.7;
