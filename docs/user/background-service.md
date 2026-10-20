# Running Lecturn in the background

On Linux and macOS, Lecturn can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host Lecturn:

| Task                            | Command                                |
| ------------------------------- | -------------------------------------- |
| Install and start               | `npx lecturn@latest service install`   |
| Inspect status and log location | `npx lecturn@latest service status`    |
| Update or repair                | `npx lecturn@latest service update`    |
| Stop and remove from startup    | `npx lecturn@latest service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.

Install and update use the version of the CLI you invoke. For nightly, use
`npx lecturn@nightly service update`; replace `nightly` with an exact version to pin
one. An older CLI refuses to replace a newer service unless you explicitly add
`--allow-downgrade`.

Updating restarts the server. Finish active work first, and wait for any remote
update already in progress. To match a remote client's version, follow
[Updating Lecturn](./updating.md).

Service installation and updates run the service from a self-contained Lecturn
runtime downloaded from a Lecturn release, so the service does not depend on
Node.js or npm. They are unavailable until a Lecturn runtime is published: until
then `service install` and `service update` stop with an explanation. Use the
Lecturn desktop app to host Lecturn Connect in the meantime.

## Self-contained CLI

The [install script](./install.md#choose-an-installation) places a self-contained
`lecturn` in `~/.local/bin`. It follows the stable train by default; set
`LECTURN_CHANNEL=nightly` for nightlies, `LECTURN_VERSION` to pin an exact
version, or `LECTURN_RELEASE_BASE_URL` to download from a mirror.

`lecturn update` moves a self-contained install to the newest release on its
channel. It is unavailable until Lecturn publishes standalone CLI release
archives; update through the Lecturn desktop app or your package manager instead.
Once available, it asks before restarting a background service for the same
Lecturn home, because a restart interrupts running agent turns, terminals, and
remote clients. Pass `--yes` from a script. A server you started by hand keeps
running the old version until you restart it. Pass an exact version to pin one,
`--channel` to switch between stable and nightly, or `--allow-downgrade` to move
backwards.

`lecturn uninstall` reverses the install script: it shows what it found (the
background service, the `lecturn` launcher, and downloaded versions under
`~/.lecturn/runtime`), asks once, and removes them. Your projects, threads, and
settings under `~/.lecturn/userdata` are kept. Pass `--yes` from a script.

## Platform support

Linux needs systemd user services. Setup enables lingering so Lecturn starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

Lecturn Connect can offer service installation during setup, but the two are managed
separately. Signing out of Lecturn Connect does not stop or uninstall the service.

## Troubleshooting

Start with `lecturn service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running Lecturn as root creates a separate installation and Connect
identity. Without administrator access, run `lecturn serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status lecturn.service`, then use the repair command printed by Lecturn.                    |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `lecturn service restart`.                       |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the Node executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.cloudgatherer.lecturn.service.plist`.

For failures after signing in to Lecturn Connect, see
[connection troubleshooting](./remote-access.md#lecturn-connect-troubleshooting).
