import type { EmbedThemeInput } from "@lecturn/embed/electron";

// A verbatim copy of the token file RocketWright generates (see
// rocketwright-theme.source), so the embed is themed by a real host's full
// variable set and fonts rather than a hand-picked sample. RocketWright checks
// on every Lecturn pin that this copy still equals its generated file.
import rocketwrightTheme from "./rocketwright-theme.json" with { type: "json" };

export const hostTheme: EmbedThemeInput = {
  theme: "dark",
  styles: {
    variables: rocketwrightTheme.variables,
    css: { fonts: rocketwrightTheme.fontsCss },
  },
};
