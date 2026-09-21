# Lecturn Connect access

Lecturn Connect brings your linked computers, managed notifications and Live Activities to your account. Local connections, direct pairing, SSH and Tailscale remain free.

## Subscription

Connect costs **$10/month or $100/year** in USD and includes three managed environments, managed push notifications and Live Activities. Start a **14-day trial with a card** on the web. The selected plan renews automatically after the trial; cancel before it ends to avoid a charge. Applicable taxes are calculated at Checkout. Sales are currently offered in the United States.

Managed Connect requires an active subscription, trial, or an explicit access grant. Creating an account alone does not activate it. Existing transition grants last only through their recorded end date and never create automatic charges. Local connections, direct pairing, SSH and Tailscale remain free.

## Desktop

Open **Settings → Billing** to check your signed-in account's Connect access and managed environment usage. Billing management opens in your browser. Use the same Lecturn account there, then return to the desktop app and refresh its status after making a change.

Your browser and desktop can be signed in to different accounts. Check the account email before managing a subscription. Returning from Checkout alone does not activate access; Lecturn must receive payment confirmation.

## Managing the relay

Open **Settings → Relay** on your desktop or locally hosted web app to see the environment's associated account and relay status. **Refresh status** checks both the local link and the associated account's relay discovery. A configured link is not necessarily online: the page distinguishes a reachable environment, an offline host, and an unavailable health check. A status dot matches the health text: green for online, amber while checking, red for offline or an error, and grey when inactive or unverified. It briefly pulses on status changes and stays still when reduced motion is enabled.

Use **Publish as** to choose the account when linking. To move this environment to another account, choose **Unlink environment**, confirm that remote access and activity publishing will stop, then select the new account and enable Lecturn Connect. Local projects and conversations stay on the host. Merely switching accounts does not transfer the environment.

The hosted web app does not run a relay itself; use its **Connections** page to connect to a published host. Relay management belongs to the host's settings.

Only one Lecturn installation on a device can publish at a time, including activity-only publishing. Stable, nightly, and development installations share that limit. If another installation owns the relay, Settings → Relay identifies the conflict. Unlink in the owning installation before linking in another; local work remains available in both. Older builds must be updated to participate in this device-wide coordination.

With multiple accounts attached, this host's projects appear under the account that actually publishes it. Unpublished local projects and direct connections remain outside the account sections. A single translucent account-colored edge runs from each account header through its contents. Thread cards carry only a faint matching tint on hover. Account, project, and thread-shelf sections expand and collapse with a coordinated glass-edge fold and chevron rotation. Reduced-motion preferences disable the transitions.

## Choosing an account

If your web or desktop client supports multiple signed-in Connect accounts, the **Account** picker in account settings chooses whose subscription you see. Billing and Teams keep the same choice while the dialog is open. The initial choice follows the open thread's account, then your last choice. An account that needs sign-in cannot be selected until you sign in again.

Changing this picker does not move environments or transfer a subscription. When you open billing in your browser, check that the same account is selected there. Signing out from billing signs out the selected account; other signed-in accounts stay connected.

## iPhone and iPad

Open **Settings** to check Connect access, managed environment usage and any access end date. Refresh the status after an account change. The iOS app is a free companion: it uses your existing account access and does not sell subscriptions or provide payment links.

Complimentary access works across devices signed in to the same account. A subscription-status error means Lecturn could not check your account; it does not mean your access has expired. Direct connections remain available when managed Connect access is inactive.

Managed notifications and Live Activities also require device permission and the corresponding settings to be enabled. An active account alone does not enable notifications on your phone.
