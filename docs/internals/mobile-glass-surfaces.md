# Mobile glass surfaces

Use `GlassCard` for scrolling cards and conversation content. It draws a static sheen with a
uniform border and no shadow. Keep message radii uniform and assistant width stable while streaming;
changing those with incoming text creates avoidable relayout and native masking work.

Use `GlassSurface` for floating chrome that benefits from native iOS glass. It has a themed fallback
on other platforms. Give the outer floating surface responsibility for its border and shadow;
controls nested inside should not add another ring.

Use the raw `bg-glass-surface` token only for small inset controls, fields, and wells. The appearance
provider makes this token and `bg-card-translucent` opaque for Reduce Transparency or increased
contrast across every registered theme. Do not add literal translucent backgrounds that bypass
this policy. `useUniwindTheme` provides the same accessible values for APIs requiring JS styles.

The two glass primitives are explicit native-gradient interop boundaries in the lint configuration;
React Native gradient strings need resolved palette colors. Other controls use semantic classes.

Read accent and border colors from the selected palette. The default Lecturn light palette is
copper; custom palettes should not inherit copper or gold literals. Static gradient highlights
retain sheen without animating shadows. Active thread borders remain a separate shared treatment.

Selection must survive opaque materials: use a solid selection marker and accent outline instead
of relying on small differences between translucent fills. Keep settled and error icons distinct
from selection indicators. Give controls actual 44-point touch bounds rather than depending on
hit slop inside clipped cards.

The accessibility store initially chooses opaque material until native preferences are known.
This favors legibility on startup. Test preference changes in both directions, as well as theme
changes while accessibility preferences remain enabled.
