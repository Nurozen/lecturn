#!/usr/bin/env bash
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sdk="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/27.1.12297006}"
out="${VM_OUT:-$here/artifacts/build}"
mkdir -p "$out"
"$ndk/toolchains/llvm/prebuilt/${NDK_HOST_TAG:-darwin-x86_64}/bin/aarch64-linux-android35-clang" \
  -std=c11 -Wall -Wextra -Werror -O2 -static -Wl,-z,relro,-z,now \
  "$here/native/runtime.c" -o "$out/runtime-control"
cp "$out/runtime-control" "$out/runtime-helper"
python3 "$here/provision/package.py" "$here" "$out"
printf 'Built ARM64 Android API 35 package: %s\n' "$out"
