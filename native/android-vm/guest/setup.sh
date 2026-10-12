#!/bin/bash
# Run ONLY inside the Ubuntu VM by its trusted bootstrap administrator.
# /opt/symba-bootstrap is a fresh seed, never a copied provider home/node_modules.
set -euo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
[[ $(id -u) == 0 && $(uname -m) == aarch64 ]]
[[ $(systemd-detect-virt) == qemu || $(systemd-detect-virt) == kvm ]]
install -d -m 755 -o root -g root /var/lib/symba-provision
# Marker contains no logs or credentials. An interrupted run cannot retain ready.
rm -f /var/lib/symba-provision/ready /var/lib/symba-provision/failed
provision_exit() {
  result=$?
  if (( result != 0 )); then
    rm -f /var/lib/symba-provision/ready
    install -m 644 /dev/null /var/lib/symba-provision/failed
  fi
}
trap provision_exit EXIT
cd /opt/symba-bootstrap
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates openssh-server python3 git ripgrep bubblewrap socat sudo xz-utils build-essential util-linux
python3 - <<'PY'
import hashlib, json
from pathlib import Path
pins = json.loads(Path('pins.json').read_text())
p = pins['node']
with open(p['file'], 'rb') as f:
    assert hashlib.file_digest(f, 'sha256').hexdigest() == p['sha256']
PY
tar -xJf node-v24.14.1-linux-arm64.tar.xz -C /usr/local --strip-components=1 --no-same-owner
[[ $(node --version) == v24.14.1 ]]
id lecturn >/dev/null 2>&1 || useradd --create-home --shell /bin/bash lecturn
[[ $(id -u lecturn) != 0 ]]
install -d -m 700 -o lecturn -g lecturn /home/lecturn/.ssh /home/lecturn/.config/symba /home/lecturn/workspace
install -m 600 -o lecturn -g lecturn authorized_keys /home/lecturn/.ssh/authorized_keys
install -m 600 -o lecturn -g lecturn agent-token /home/lecturn/.config/symba/agent-token
# Optional guest-only administrative policy. Does not grant any Android permission.
if [[ -e allow-guest-sudo ]]; then
  printf 'lecturn ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/lecturn-guest
  chmod 440 /etc/sudoers.d/lecturn-guest
  visudo -cf /etc/sudoers.d/lecturn-guest >/dev/null
fi
install -d -m 755 /opt/lecturn-tools
install -m 644 package.json package-lock.json /opt/lecturn-tools/
cd /opt/lecturn-tools
# The legacy peer setting must match lock generation. Never resolve at first boot.
(umask 022; npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund)
python3 /opt/symba-bootstrap/verify-npm.py
for command in codex claude lecturn; do
  ln -sf "/opt/lecturn-tools/node_modules/.bin/$command" "/usr/local/bin/$command"
done
# Ubuntu's AppArmor userns restriction otherwise blocks provider bubblewrap.
# This guest kernel is separate from the Android/host-chroot kernel.
install -m 644 /opt/symba-bootstrap/60-symba-userns.conf /etc/sysctl.d/60-symba-userns.conf
sysctl -p /etc/sysctl.d/60-symba-userns.conf
[[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns) == 0 ]]
install -d -m 755 /usr/local/libexec
install -m 755 /opt/symba-bootstrap/provision-status.py /usr/local/libexec/symba-provision-status
install -m 755 /opt/symba-bootstrap/check-sandbox.py /usr/local/libexec/symba-check-sandbox
# Empty temporary provider home; no login, credentials, model turn or fallback.
runuser -u lecturn -- env -i HOME=/home/lecturn PATH=/usr/local/bin:/usr/bin:/bin \
  python3 /usr/local/libexec/symba-check-sandbox > /var/lib/symba-provision/sandbox-check.json
install -m 644 /opt/symba-bootstrap/lecturn.service /etc/systemd/system/lecturn.service
install -m 644 /opt/symba-bootstrap/sshd.conf /etc/ssh/sshd_config.d/00-symba.conf
sshd -t
umask 077
mkdir -p /var/lib/symba-provision
cp package.json /var/lib/symba-provision/npm-package.json
cp package-lock.json /var/lib/symba-provision/npm-package-lock.json
cp /opt/symba-bootstrap/pins.json /var/lib/symba-provision/pins.json
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | sort > /var/lib/symba-provision/guest-dpkg.lock
runuser -u lecturn -- env HOME=/home/lecturn PATH=/usr/local/bin:/usr/bin:/bin codex --version > /var/lib/symba-provision/codex.version
runuser -u lecturn -- env HOME=/home/lecturn PATH=/usr/local/bin:/usr/bin:/bin claude --version > /var/lib/symba-provision/claude.version
systemctl daemon-reload
systemctl enable lecturn.service
systemctl restart ssh.service
systemctl start lecturn.service
systemctl is-active --quiet lecturn.service
# This means provisioned, not authenticated runtime health (checked separately).
install -m 644 /dev/null /var/lib/symba-provision/ready
