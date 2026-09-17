# Install Lecturn

Drag **Lecturn.app** into Applications. Lecturn has its own application name, URL handler, settings, saved connections, credentials, and conversation database.

Lecturn stores runtime data in `~/.lecturn/userdata`. Development sessions use a separate development directory. `LECTURN_HOME` or the explicit `--base-dir` option can select another base directory.

Open the Lecturn app, sign in to Lecturn Connect, and link this computer to make it available from the Lecturn web and mobile apps. The desktop app must remain running to host the connection.

The standalone CLI command is `lecturn`. Automatic standalone service installation and server updates are unavailable until a Lecturn runtime distribution is published. Use the desktop application to host Connect and install desktop updates from Lecturn's release feed.

## Run two desktop builds together

Give each running Lecturn build a different home. With an explicit `LECTURN_HOME`, the desktop
app stores its browser profile and saved connections under `<home>/userdata/electron`, alongside
its separate backend data. A different app name or update channel alone does not separate these
files. Builds without an override keep using the existing default profile.

For example, leave Lecturn Nightly running normally and launch a local test build on macOS with:

```sh
open -n /Applications/Lecturn.app \
  --env "LECTURN_HOME=$HOME/.lecturn-stave-test" \
  --env T3CODE_DISABLE_AUTO_UPDATE=true
```

Use that command again when reopening the test build. It starts with its own projects, settings,
and connections; add a project and enable Stave in Settings → General → Stave as needed. The
desktop selects an available local backend port automatically. Older builds that only redirect
backend data with `LECTURN_HOME` need to be updated before using this arrangement.

## iPhone and iPad

Lecturn is available as a public TestFlight beta. Install Apple's TestFlight app, open the public link at https://testflight.apple.com/join/AY9PU516 on your device, and install Lecturn. There is no App Store release yet.

Sign in to Lecturn Connect in both the desktop and mobile apps. Keep the desktop app running and link the computer to your account, then select that computer in Lecturn on your phone. In desktop Settings → Connections, enable **Publish agent activity**. Allow notifications when iOS asks; enable the activity notification or Live Activity options you want in Lecturn Settings. Start an agent task on the connected computer to check activity updates and notification delivery on your device.

Live Activities use Lecturn’s navy background, warm text, gold thread accents and larger logo, including the activity mirrored in your Mac’s menu bar. Status labels retain distinct attention, completion and failure colors. The gold sheen stays still; Apple controls Live Activity update animations and the surrounding menu-bar or Dynamic Island appearance. Standard notification banners also retain the system’s appearance.

The **Device Notifications** switch reflects notification permission on your phone. It turns on after you allow permission; delivery setup may finish separately. If Settings shows setup is pending, check your connection and reopen Settings to retry. Notifications can arrive even while the app is reconnecting to a computer, so test both notification delivery and opening a conversation on your device.

For setup steps, activity status meanings, and delivery troubleshooting, see [Notifications and Live Activities](./notifications-and-live-activities.md).
