# Remote access

Connect a phone, browser, or another desktop app to Lecturn running on a different
machine. That machine must stay running and reachable while you work.

## Lecturn Connect

Lecturn Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **Lecturn Connect** for that environment.

For a command-line host, run:

```bash
npx lecturn@latest connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `npx lecturn serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same Lecturn Connect account and choose the
environment. Over SSH, the CLI prints a browser link and accepts the returned
authorization code, so you do not need to forward an OAuth callback port.

Lecturn Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
npx lecturn serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
npx lecturn pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
npx lecturn serve --tailscale-serve
```

For an already-running server:

```bash
npx lecturn pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `npx lecturn pair --help` for other pairing options.

### Hosted web app

[lecturn.cloudgatherer.net](https://lecturn.cloudgatherer.net) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Lecturn starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host needs a compatible [Node.js installation](./install.md#requirements)
and [provider setup](./install.md#providers). If launch cannot find Node or reports
an incompatible version, check it through a non-interactive SSH session:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure your version manager for non-interactive shells if this differs from
your normal terminal. With nvm, setting a compatible default, such as
`nvm alias default 24`, can resolve the problem.

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Lecturn launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `npx lecturn auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from Lecturn Connect, open your account menu's **Lecturn Connect**
page, or **Settings → Lecturn Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped.

On a command-line host, `lecturn connect unlink` disables exposure while retaining
your login; `lecturn connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Lecturn Connect troubleshooting

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `lecturn auth` to revoke credentials or sessions you no longer trust.

## Signing out and switching your Connect account

Signing out removes that account's Connect environments from this client, together with their drafts and cached threads. Signing in as a different account does the same for the previous account.

If your session expires without a sign-out, your Connect environments stay in your list, disconnected, along with their drafts and cached threads. Sign in again with the same account to reconnect them.

The signed-in account belongs to the app you are using. The hosted web app, the desktop app, and a locally served web app each keep their own. A locally served web app keeps a separate one for each port it is served on, so signing in on one port does not sign you in on another.

Desktop sign-out asks for confirmation before unpublishing this computer. Confirming stops its remote Connect access, notifications and Live Activities, then signs out. Your local projects and conversations stay on the computer. If cleanup fails, Lecturn keeps you signed in and offers a retry.

Browser sign-out affects that client only; it does not unpublish a remote computer you are viewing.

After signing out on desktop, sign in with the new account and run Connect setup again. Account switching does not transfer a subscription.

If this computer was already published to another account, the sign-out dialog explains that it will stop the local relay, while the previous account may retain an offline registration. Sign in to the previous account to remove that registration. Lecturn does not revoke another account's registration using your current account.

You can also stop publication explicitly from **Settings → Connections → Unlink environment** while signed in to the account that published it.

## Separate Connect identities

When multiple Connect accounts are available, add them from the account menu on web or desktop, or **Settings → Connect accounts** on mobile. Each account retains its own environments, subscription, and team selection. Labels and colors help distinguish accounts across devices. Directly paired environments remain separate from Connect accounts.

Signing out of one account removes its saved Connect access on that client without signing out your other accounts. An expired sign-in keeps an account section visible so you can restore access. Adding an account does not share a computer with another person or grant that account access to another account's environment.
Run `lecturn connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `lecturn service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart Lecturn on the host.                                                                                        |
| `auth_invalid` or `invalid_bearer`                        | Run `lecturn connect login`. If credentials were revoked, run `lecturn connect logout`, then `lecturn connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Lecturn, then restart it.                                                                                           |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                              |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                                            |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart lecturn.service` for the background service. For a
foreground server, stop it and run `lecturn serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating Lecturn](./updating.md).
