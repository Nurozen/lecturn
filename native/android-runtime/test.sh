#!/usr/bin/env bash
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
: "${ORG_JSON_JAR:?Set ORG_JSON_JAR to an existing trusted org.json implementation (Android SDK jar is stubs)}"
out="${BROKER_OUT:-$here/artifacts/test}"
mkdir -p "$out/test-classes"
"$JAVA_HOME/bin/javac" --release 11 -Xlint:all -Werror -cp "$sdk/platforms/android-36/android.jar" -d "$out/test-classes" "$here"/src/dev/lecturn/broker/*.java "$here"/test/dev/lecturn/broker/*.java
"$JAVA_HOME/bin/java" -cp "$out/test-classes:$ORG_JSON_JAR:$sdk/platforms/android-36/android.jar" dev.lecturn.broker.BrokerTest
BROKER_TEST_TMP="$out" PYTHONDONTWRITEBYTECODE=1 python3 "$here/test/test_mobile_mcp.py"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror "$here/test/securefs_paths_test.c" -o "$out/securefs_paths_test"
"$out/securefs_paths_test"
