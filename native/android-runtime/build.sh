#!/usr/bin/env bash
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
out="${BROKER_OUT:-$here/artifacts/build}"
mkdir -p "$out/classes" "$out/dex"
android="$sdk/platforms/android-36/android.jar"
"$JAVA_HOME/bin/javac" --release 11 -Xlint:all -Werror -cp "$android" -d "$out/classes" "$here"/src/dev/lecturn/broker/*.java
"$JAVA_HOME/bin/jar" cf "$out/classes.jar" -C "$out/classes" .
"$sdk/build-tools/36.0.0/d8" --min-api 30 --lib "$android" --output "$out/dex" "$out/classes.jar"
"$JAVA_HOME/bin/jar" cf "$out/lecturn-device-broker.jar" -C "$out/dex" classes.dex
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/27.1.12297006}"
prebuilt="${NDK_HOST_TAG:-darwin-x86_64}"
"$ndk/toolchains/llvm/prebuilt/$prebuilt/bin/aarch64-linux-android30-clang" -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared -Wl,-z,relro,-z,now -o "$out/liblecturn_securefs.so" "$here/native/securefs.c" "$here/native/physical_input.c"
printf '%s\n' "$out/lecturn-device-broker.jar" "$out/liblecturn_securefs.so"
