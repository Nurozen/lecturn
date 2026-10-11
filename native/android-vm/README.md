# Android VM runtime package

Experimental launcher and provisioning package for the ARM64 Pixel `kodiak`
KVM path. Installed on SymbaOS `2026101104`: nonroot guest provisioning, provider
CLI startup, clean VM stop/restart, authenticated Lecturn pairing, native
dependencies and guest-to-Android MCP transport were verified. Provider login
and authenticated inference remain separate qualification gates. This requires
the custom userdebug OS integration; it is not a stock Android installer.
Contracts: [native broker](../android-runtime/README.md) and
[APK](../../apps/android-host/README.md).

## Build and check locally

```sh
./build.sh
./test.sh
```

Requires Python 3 and local NDK `27.1.12297006`; targets ARM64 Android API 35.
`VM_OUT`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, and `NDK_HOST_TAG` are build-only
overrides. Outputs default to ignored `artifacts/build/`: static Android
`runtime-control`, its `runtime-helper` copy, an inspectable package tree,
manifest, tar and SHA-256. There are no downloads, credentials, servers, device
commands, or Linux package installs in build/test. The glibc fwmark shim must be
compiled later inside the prepared ARM64 host with `provision/host-setup.sh`.

`pins.json` captures the parent's exact rootfs, cloud-image and Node digests and
provider versions. The rootfs checksum is from the supplied Ubuntu checksum
file; cloud digest/date are from the parent's integrity record. Mutable
`noble/current` URLs are deliberately not a download fallback. Retain these
artifacts. Host/guest apt package versions are captured during provisioning, not
a prequalified apt snapshot. The shipped `guest/package-lock.json` captures npm
transitive versions and integrity, including optional Linux ARM64 binaries.
The beta.103 `@effect/platform-node-shared` override prevents the pinned nightly's
range from selecting stable 4.x with incompatible Effect peers. Provisioning runs
`npm ci --legacy-peer-deps` against that lock, verifies installed manifests, and
retains both manifest and lock in `/var/lib/symba-provision`. No Mac `node_modules`
is used. Local verification installed ARM64 packages with scripts disabled; the
guest must still qualify native install scripts. `ini@7.0.0` declares Node
`^24.15.0` while the supplied image pins 24.14.1: this engine warning is retained
as a parent qualification gate, not hidden by changing engine checks.

## Installed boundary

```text
/data/local/symba-runtime/                 root:root 0700
  bin/runtime-control                     root:root 0755, static native ELF
  state/                                  root:root 0700
    config.json                           root:root 0600
    lifecycle.json, control.lock          root:root 0600 (controller-managed)
    ssh-key, known_hosts                  root:root 0600 (fresh guest admin key)
    agent-token                           root:root 0600 (distinct native agent token)
    runtime.json                          root:root 0600 (parent auth descriptor)
  host/                                   root:root 0755, Ubuntu host chroot
    usr/local/libexec/runtime-helper       root:root 0755, same static ELF
    usr/local/libexec/runtime_controller.py
    usr/local/lib/libsymba-fwmark.so        glibc library, root-owned
    opt/vm/base.qcow2                      root:root 0444, pinned image
    opt/vm/guest.qcow2                     actual APK UID 0600, persistent overlay
    opt/vm/seed.iso                        actual APK UID 0400
    opt/vm/console.log                     actual APK UID 0600, treat as private
    opt/vm/run/                            actual APK UID 0700, QMP socket only
```

Only resource counts and the explicit network-boundary acknowledgement are
configurable in root-owned `state/config.json`; see `config.example.json`.
Commands, executable paths, package, mounts and ports are fixed. There are no
guest-controlled paths, environment overrides, command strings or grant intents.
The package UID comes from Android's package API (`cmd package list packages -U
--user 0`) with an exact package match, never a baked-in UID. Android activity
state must be numeric and foreground (at most FGS state 4) on start/health. The
APK must keep its foreground service active; this controller cannot create that
Android lifecycle exemption. Stop remains possible even if the APK was removed.

The native launcher uses **only C `unshare(CLONE_NEWNS)` and recursive
`mount(MS_PRIVATE)`** before any mount. It verifies the namespace changed, differs
from init, and has no shared/slave propagation. It never uses toybox unshare or
mount-private. Each invocation gets private proc, tmpfs `/dev`, null/zero/random/
urandom/tty, a newly created KVM node, and a new devpts instance. Only the
`/dev/socket/fwmarkd` socket is bind-mounted. There is no whole `/dev`, `/data`, or
APK-data mount. Host state is visible to the root **host controller** at
`/run/symba-state`, mode 0700; it never enters the VM. QEMU runs as the dynamic APK
UID with only supplementary group 3003, empty effective/permitted/inheritable/
bounding capabilities, and `no_new_privs=1`. This is a VM with its own kernel;
Android USER_NS/PID_NS support is not assumed.

## Lifecycle contract

`runtime-control start|stop|status` emits one JSON object, schema version 1,
under 64 KiB. An inherited native 28-second watchdog bounds the entire invocation,
including package queries. All operations take a nonblocking exclusive `flock`;
overlap returns an explicit error to retry. No concurrent VM starts. The runtime
UUID is generated for each actual new VM and stays stable through that boot.

Start records and fsyncs PID, kernel start time, Android boot UUID and mount
namespace **before releasing a gated child**. QEMU runs without `-daemonize`;
stdout/stderr/stdin are detached from the broker. The only durable processes are
QEMU and a fixed-argument SSH reverse bridge (no shell/proxy/config/agent).
Status also reconciles first-boot SSH bridge creation after guest health succeeds;
it does not restart a crashed VM or bridge. `ready` requires fresh QMP running
state, pinned-key SSH to the nonroot guest user, a root-owned provisioning-ready
marker, and active nonroot Lecturn service,
a listening guest reverse bridge, and authenticated HTTP 200 with an orchestration
shell shape. No redirects or cached successful health. Broker health remains the
authoritative activity/policy adapter.

Cloud-init completion alone cannot satisfy guest readiness. Setup clears prior
markers, records a failed shell exit, and writes `/var/lib/symba-provision/ready`
only after installation, sandbox checks and service startup. A failed marker or
completed cloud-init without ready becomes an explicit controller error; missing
markers during cloud-init remain starting. Check the guest's root-owned locks,
`sandbox-check.json`, cloud-init output and service journal when setup fails.

Stop validates QMP's Unix peer PID against captured provenance before sending
`system_powerdown`. It waits for QEMU exit, then terminates the captured SSH bridge
with a pidfd and verifies exit. There is no blind `kill`, process-name match, QMP
`quit`, or forced QEMU kill fallback. Timeout is **error**, retaining provenance
for reconciliation; never a false stopped acknowledgement. Stale/untracked QMP,
PID reuse, or changed APK UID fails closed. A dead prior VM requires explicit stop
and then start. Successful stop retains guest disks, workspace, provider homes and
Lecturn state; restart submits no tasks or replay commands. Parent must qualify
the pinned Lecturn release's startup behavior against this no-replay requirement.

## Network and authentication

QEMU forwards host `127.0.0.1:3773` to guest 3773 and host `127.0.0.1:18722` to
guest SSH. Guest Lecturn binds its VM interface (`0.0.0.0:3773`), because a guest
loopback-only listener cannot receive SLIRP hostfwd. Pinned-host-key SSH establishes
**only** `-R 127.0.0.1:18769:127.0.0.1:18769`. Guest sshd restricts remote listeners
to that address/port, disallows root/password login, agent forwarding and tunnels.
Maintenance 18722 remains mandatory in this candidate for health and the reverse
bridge; disabling it needs a separately qualified transport.

**SLIRP's `10.0.2.2` inherently reaches host loopback, including 18768.** Absence
of a control-port forward is not a firewall. Neither other Android apps nor the
guest can be trusted merely because a listener is loopback. This package therefore
explicitly requires the broker's separate strong control token on every control
operation, Origin/Referer rejection and no grant route on the agent listener.
Only the separate agent token enters the guest. It does not implement an Android
firewall policy or claim network separation of control. If release policy requires
packet-level denial, parent must add and qualify that policy before shipping.

Parent provisions `state/runtime.json` atomically, root-owned 0600, with exactly:
`schemaVersion: 1`, `uiUrl: "http://127.0.0.1:3773"`, and a real freshly issued
`lecturnBearerToken`. Never place a token in uiUrl, argv, logs or this repository.
The APK-owned controller credential is separately provisioned per the broker
contract; it is never copied here or into the VM. The native agent token is
fresh random 64-hex and must differ from the APK controller token.

Start does **not** require `state/runtime.json`. Boot the provisioned guest first,
issue a real Lecturn token after the server runs, then atomically install that
descriptor. Until then status remains starting and cannot report ready. This does
not waive the broker's separate authorization for the start operation.

## Guest sandbox policy

Root bootstrap installs `guest/60-symba-userns.conf` **inside the QEMU guest only**.
It sets `kernel.apparmor_restrict_unprivileged_userns=0`, allowing unprivileged
namespaces used by provider sandboxes. This is a guest-wide relaxation of Ubuntu's
userns restriction, not an Android/host sysctl change or disabling AppArmor or
provider sandboxing. See [Ubuntu's restriction documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).
The VM/architecture guards run before the write, and setup checks the live value.

Before ready, the nonroot `lecturn` user runs an offline probe through actual
`codex sandbox` (the pinned 0.160.1 selects Linux automatically) with read-only policy and through bubblewrap. Both must read
an otherwise writable synthetic fixture and deny its modification; a failed
launcher or missing success receipt fails provisioning. The probe uses a fresh
temporary provider home and never reads login state, submits a turn or falls back
to unsandboxed execution. It records Codex enforcement and bubblewrap prerequisites;
it does not claim Claude's Bash sandbox has been exercised. The parent must verify
Claude's enabled sandbox, denied writes and absence of an unsandboxed fallback
after fresh login, including when `--allow-guest-sudo` is selected. Guest sudo
authority and provider sandbox policy are separate decisions.

**Full UI pairing is a separate parent/APK bootstrap API flow.** A broker bearer
health token does not pair the WebView. The parent's private API must deliver a
fresh one-time fullweb pairing credential to the APK, then use the existing
fullweb auth bootstrap/session flow. The regular status uiUrl stays credential-free.
This package does not add that API or mint a fake pairing URL. Provider login must
also be fresh on the phone. Register the broker's stdio MCP adapter with the guest
user through normal provider approvals; Android grants remain independent.

## Parent provisioning handoff

1. Cold-stop and verify all probe processes and mounts, then let the parent move
   the existing host rootfs according to `adopt-rootfs.example.json`. **Do not copy
   or move a running rootfs/disk.** The installer does not perform the move or kill
   probe processes. Preserve `/opt/vm/base.qcow2` backing paths inside the chroot.
   Reconcile/remove old pidfiles/sockets only after observed exit. Audit adopted
   host ownership and symlinks; runtime paths and ancestors must satisfy the broker
   trusted-path contract. Set the runtime root 0700, host root 0755 and state 0700.
2. Review the built manifest and candidate config. Parent alone may run:

   ```sh
   python3 provision/install.py --serial "$EXACT_SERIAL" \
     --expected-fingerprint "$EXACT_BUILD_FINGERPRINT" \
     --bundle artifacts/build/runtime-package.tar \
     --config config.example.json --adoption-descriptor adopt-rootfs.example.json
   ```

   It requires exact `kodiak`, ARM64 ABI, fingerprint and already-authorized root
   transport; validates archive scope/digests; refuses installed/active state;
   checks extraction ancestors; and stages only the candidate. It never calls
   `adb root`, changes SELinux or touches init. Parent must still assert coldness:
   absence of old pidfiles alone is not process-exit evidence.

3. In a parent-prepared **private** host namespace, compile/install the glibc shim
   with the packaged `host-setup.sh`; configure DNS/CA/default network as qualified
   by the parent. Archive the resulting host dependency lock. Never substitute a
   shared toybox mount operation. This step and first guest apt/npm need network.
4. For a **new guest**, stage the three pinned downloads in the root host context
   and run `python3 /usr/local/share/symba-runtime/guest-seed.py --sources
/usr/local/share/symba-runtime --downloads /root/pinned-downloads` there. It verifies digests, creates fresh SSH client/guest host
   keys and native agent token, generates cloud-init media and a persistent qcow2
   overlay. Optional `--allow-guest-sudo` grants guest-only NOPASSWD sudo. No secrets
   print. Existing disk/key/token paths cause refusal, never overwrite.
   For the **existing probe guest**, preserve its disk/workspace and have the parent
   stage fresh seed inputs, pinned known_hosts and run `guest/setup.sh` as its
   bootstrap administrator. Do not reuse probe SSH keys or run providers as root.
   Validate the resulting `lecturn` user's UID, paths and pinned provider versions.
5. Keep the APK foreground service active, provision the broker/guest agent token,
   and start the VM without a Lecturn auth descriptor. Wait for the guest's root
   ready marker and running server; only then issue the real Lecturn token and
   provision the auth descriptor. Exercise native start/status/stop. Qualify current firmware SELinux/KVM/fwmark access, Codex, Claude and
   Lecturn executables as the guest user, shutdown completion, APK caching,
   network changes, restart persistence, and no task replay. Runtime readiness is
   expected to stay `starting` until authenticated guest setup is complete.
6. Parent owns init/SELinux integration, fullweb pairing API, native service
   supervision and release qualification. **No reboot integration is implemented
   or claimed here.** See `human.md` for checkable integration gates.
