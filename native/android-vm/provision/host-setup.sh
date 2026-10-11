#!/bin/bash
# Run by the parent INSIDE the cold ARM64 Ubuntu host chroot with its network prepared.
set -euo pipefail
[[ $(id -u) == 0 && $(uname -m) == aarch64 ]]
[[ -e /usr/local/share/symba-runtime/pins.json ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 openssh-client qemu-system-arm qemu-efi-aarch64 qemu-utils gcc libc6-dev genisoimage ca-certificates
qemu-system-aarch64 --version | head -1 | grep -F '8.2.2'
mkdir -p /usr/local/lib /run/symba-state /opt/vm/run
chmod 700 /run/symba-state /opt/vm/run
# glibc, not Android's Bionic compiler: this library is loaded only by host Linux tools.
gcc -std=c11 -O2 -Wall -Wextra -Werror -shared -fPIC -Wl,-z,relro,-z,now \
 /usr/local/share/symba-runtime/fwmark.c -ldl -pthread -o /usr/local/lib/libsymba-fwmark.so
chmod 755 /usr/local/lib/libsymba-fwmark.so
chown root:root /usr/local/lib/libsymba-fwmark.so
umask 077
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | sort > /usr/local/share/symba-runtime/host-dpkg.lock
qemu-system-aarch64 --version > /usr/local/share/symba-runtime/host-qemu.version
