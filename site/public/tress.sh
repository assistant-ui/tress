#!/bin/sh
# Install tress from assistant-ui/tress. Keep all work inside main so a
# partially downloaded script cannot start an installation.

main() {
  set -eu

  case "${1:-}" in
    --help|-h)
      printf '%s\n' 'Install tress for macOS or Linux.' \
        'TRESS_INSTALL_DIR: destination (default: ~/.local/bin)' \
        'TRESS_VERSION: release tag to install (default: latest)' \
        'Before the first release, builds main with an existing Rust toolchain.'
      return
      ;;
    '') ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 1 ;;
  esac

  fail() { printf 'tress: %s\n' "$*" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || fail 'curl is required.'

  case "$(uname -s)" in
    Darwin) platform=apple-darwin ;;
    Linux) platform=unknown-linux-musl ;;
    *) fail 'This installer supports macOS and Linux (including WSL).' ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) architecture=aarch64 ;;
    x86_64|amd64) architecture=x86_64 ;;
    *) fail 'This installer supports ARM64 and x86-64.' ;;
  esac

  repository=https://github.com/assistant-ui/tress
  version=${TRESS_VERSION:-}
  install_dir=${TRESS_INSTALL_DIR:-"$HOME/.local/bin"}
  case "$install_dir" in /*) ;; *) fail 'TRESS_INSTALL_DIR must be an absolute path.' ;; esac
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/tress-install.XXXXXX")
  staged=
  trap 'rm -rf "$temp_dir"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Resolve latest once, then fetch both files from the same immutable tag.
  if [ -z "$version" ]; then
    release=$(curl --silent --show-error --location --retry 2 \
      --connect-timeout 10 --max-time 60 --output /dev/null \
      --write-out '%{http_code} %{url_effective}' "$repository/releases/latest") \
      || fail 'Could not reach GitHub. Please retry.'
    case "$release" in
      "200 $repository/releases/tag/"*) version=${release#"200 $repository/releases/tag/"} ;;
      "404 "*) ;;
      *) fail 'Could not find the latest release. Please retry.' ;;
    esac
  fi

  if [ -n "$version" ]; then
    case "$version" in v[0-9]*) ;; *) fail 'TRESS_VERSION must be a release tag such as v0.1.0.' ;; esac
    case "$version" in *[!A-Za-z0-9._-]*) fail 'Invalid release tag.' ;; esac
    asset="tress-$architecture-$platform"
    download="$repository/releases/download/$version"
    printf 'Downloading tress %s…\n' "$version"
    curl --fail --silent --show-error --location --retry 2 \
      --connect-timeout 10 --max-time 300 "$download/$asset" \
      --output "$temp_dir/tress" || fail 'Binary download failed.'
    curl --fail --silent --show-error --location --retry 2 \
      --connect-timeout 10 --max-time 60 "$download/SHA256SUMS" \
      --output "$temp_dir/SHA256SUMS" || fail 'Checksum download failed.'
    expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temp_dir/SHA256SUMS")
    [ "${#expected}" -eq 64 ] || fail 'Missing or invalid checksum.'
    case "$expected" in *[!a-f0-9]*) fail 'Invalid checksum.' ;; esac
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$temp_dir/tress" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$temp_dir/tress" | awk '{print $1}')
    else
      fail 'sha256sum or shasum is required to verify the download.'
    fi
    [ "$actual" = "$expected" ] || fail 'Checksum mismatch; nothing was installed.'
    binary="$temp_dir/tress"
  else
    command -v cargo >/dev/null 2>&1 || fail \
      'No binary release is published yet. Install Rust from https://rustup.rs, then rerun this command.'
    printf '%s\n' 'No binary release yet. Building merged main with Cargo (this may take a few minutes)…'
    cargo install --locked --git "$repository" --branch main \
      --root "$temp_dir/source" tress
    binary="$temp_dir/source/bin/tress"
  fi

  chmod 755 "$binary"
  help=$("$binary" --help) || fail 'This CLI build cannot run on your machine.'
  case "$help" in
    *--session*) ;;
    *) fail 'This CLI build does not support demo sessions yet. Please retry after the updated CLI is published.' ;;
  esac

  mkdir -p "$install_dir"
  staged=$(mktemp "$install_dir/.tress.XXXXXX")
  cp "$binary" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$install_dir/tress"
  staged=
  printf 'Installed tress to %s/tress\n' "$install_dir"
  case ":$PATH:" in
    *":$install_dir:"*) printf '%s\n' 'Run: tress --help' ;;
    *) printf 'Add %s to your PATH, then run: tress --help\n' "$install_dir" ;;
  esac
}

main "$@"
