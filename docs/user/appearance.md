# Appearance and themes

Open **Settings → Appearance** to choose a theme and follow the system appearance or stay in light
or dark mode. To use different themes for light and dark mode, select the corresponding preview
within each theme. Appearance preferences are saved separately on each device or browser.

Mobile has its own themes and text, code, and terminal preferences. It does not follow environment
themes or defaults.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Lecturn or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. lecturn.cloudgatherer.net and additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, Lecturn falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
lecturn theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `lecturn theme set`. Run the command again to
reapply it, even if the name is unchanged.

`lecturn theme clear` removes the default without changing anyone's current theme. `lecturn theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from Lecturn into `~/.lecturn/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `lecturn theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. Lecturn
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

## Mobile surfaces

Thread lists, conversations, pull requests, and tool sheets share rounded glass surfaces over the
existing celestial backgrounds. The Lecturn theme pairs midnight glass and gold accents in dark
mode with pearl surfaces and copper accents in light mode. Working borders keep their metallic
trail; settled threads retain their red-gold outline and expandable hierarchy.

On supported iOS versions, floating controls use the system glass material. Scrolling cards use a
lightweight sheen so long conversations and lists stay responsive. Other devices use matching
material colors and highlights. Reduce Transparency and increased-contrast settings use solid
surfaces instead, including smaller controls and input fields.

On iOS, interface text and composer chips use Apple's system typeface with matching regular,
medium, and bold weights. Android retains DM Sans. The default mobile palette deliberately uses
neutral light text over midnight glass and stronger surface borders; the web and desktop palettes
retain their existing typography and text colors. Other selected themes keep their own accent hues.

Model, reasoning, and access details remain visible in an inset glass drawer below the conversation
composer; tap the strip to change settings. The drawer keeps its outline when the editor gains or
loses focus. Conversations fade in briefly once their messages are ready. Pull requests with a managing agent keep their steering field visible. Files,
terminal, review, Git, approvals, and thread actions remain available through their existing controls.

## Account colors

When multiple Connect accounts are available, a rounded glass rail wraps each account’s thread
section. Project connectors and selected cards share that account’s color, while settled branches
retain red. Compact account headings and animated chevrons keep the hierarchy easy to scan. With
one account, or without signing in, the Lecturn theme uses soft gold accents.

An account’s conversation, composer, and pull requests use its selected tint over your current
theme. Direct connections and native navigation headers keep the base theme. Phone navigation
keeps its native gestures; layouts that switch conversations in place can show a brief glass sweep
when the account or project changes. Reduce Motion disables decorative transitions. Reduce
Transparency and increased contrast take precedence over translucent surfaces.
