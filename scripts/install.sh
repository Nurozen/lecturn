#!/bin/sh
# Installs the Lecturn CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/Nurozen/lecturn/main/scripts/install.sh | sh
#
# Environment:
#   LECTURN_CHANNEL          release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   LECTURN_VERSION          exact version to install (overrides LECTURN_CHANNEL)
#   LECTURN_HOME             Lecturn home directory (default: ~/.lecturn)
#   LECTURN_INSTALL_BIN_DIR  where the `lecturn` symlink goes (default: ~/.local/bin)
#   LECTURN_RELEASE_BASE_URL mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $LECTURN_HOME/runtime/versions/<version>, the
# same layout `lecturn service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="Nurozen/lecturn"
base_url="${LECTURN_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
lecturn_home="${LECTURN_HOME:-$HOME/.lecturn}"
bin_dir="${LECTURN_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'lecturn install: %s\n' "$1" >&2
  exit 1
}

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${LECTURN_CHANNEL:-stable}"
version="${LECTURN_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "LECTURN_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set LECTURN_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "lecturn ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set LECTURN_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${LECTURN_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="lecturn-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${lecturn_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  printf 'lecturn %s is already installed at %s\n' "$version" "$target_dir"
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT

  printf 'Downloading %s...\n' "$archive"
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "lecturn ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g lecturn@${version}\`"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  fetch "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/lecturn" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

mkdir -p "$bin_dir"
ln -sfn "${target_dir}/lecturn" "${bin_dir}/lecturn"
printf 'Installed lecturn %s\n  %s -> %s\n' "$version" "${bin_dir}/lecturn" "${target_dir}/lecturn"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) printf 'Add %s to your PATH to run `lecturn`.\n' "$bin_dir" ;;
esac
