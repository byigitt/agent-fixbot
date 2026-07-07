#!/usr/bin/env bash
# Installs the CLI tools agent-fixbot needs to run unattended on a fresh host:
#   node (v22+), pnpm, git, gh, and the coding agent CLI (omp).
# Supported platforms: macOS (Homebrew) and Debian/Ubuntu Linux (apt).
# Idempotent: tools already on PATH (and new enough) are left alone.
#
# Usage: ./scripts/install-tools.sh [--skip-agent]
#   --skip-agent   do not install the coding agent CLI (omp); use when you
#                  point .fixbot.json `agent` at a different CLI.
set -euo pipefail

MIN_NODE_MAJOR=22
AGENT_PACKAGE="@oh-my-pi/pi-coding-agent" # provides the `omp` binary
SKIP_AGENT=0

for arg in "$@"; do
  case "$arg" in
    --skip-agent) SKIP_AGENT=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[install-tools] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
SUDO=""
if [ "$OS" = "Linux" ] && [ "$(id -u)" != "0" ]; then
  if have sudo; then
    SUDO="sudo"
  else
    echo "error: not root and sudo is unavailable; run as root or install sudo" >&2
    exit 1
  fi
fi

node_ok() {
  have node || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

apt_install() {
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

install_linux() {
  if ! have apt-get; then
    echo "error: only apt-based Linux (Debian/Ubuntu) is supported; install node>=${MIN_NODE_MAJOR}, pnpm, git, and gh manually" >&2
    exit 1
  fi

  $SUDO apt-get update -y
  apt_install ca-certificates curl gnupg

  if have git; then
    log "git already installed: $(git --version)"
  else
    log "installing git via apt"
    apt_install git
  fi

  if node_ok; then
    log "node already installed: $(node --version)"
  else
    log "installing node ${MIN_NODE_MAJOR}.x via NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | $SUDO -E bash -
    apt_install nodejs
  fi

  if have gh; then
    log "gh already installed: $(gh --version | head -n1)"
  else
    log "installing gh via the official GitHub CLI apt repository"
    $SUDO mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    $SUDO apt-get update -y
    apt_install gh
  fi
}

install_darwin() {
  if ! have brew; then
    # Bootstrapping Homebrew needs an interactive sudo password, so we do not
    # attempt it unattended. One-time manual step:
    echo "error: Homebrew is required on macOS. Install it first:" >&2
    echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
    echo "then re-run this script." >&2
    exit 1
  fi

  if have git; then
    log "git already installed: $(git --version)"
  else
    log "installing git via Homebrew"
    brew install git
  fi

  if node_ok; then
    log "node already installed: $(node --version)"
  else
    log "installing node via Homebrew"
    brew install node
  fi

  if have gh; then
    log "gh already installed: $(gh --version | head -n1)"
  else
    log "installing gh via Homebrew"
    brew install gh
  fi
}

case "$OS" in
  Linux) install_linux ;;
  Darwin) install_darwin ;;
  *)
    echo "error: unsupported OS: $OS (supported: macOS, Debian/Ubuntu Linux)" >&2
    exit 1
    ;;
esac

# pnpm: prefer corepack (respects the repo's packageManager pin); fall back to
# a global npm install on node builds that no longer bundle corepack.
if have pnpm; then
  log "pnpm already installed: $(pnpm --version)"
elif have corepack; then
  log "enabling pnpm via corepack"
  corepack enable pnpm
else
  log "installing pnpm via npm"
  npm install -g pnpm
fi

# Coding agent CLI (default `agent.command` in .fixbot.json is `omp`).
if [ "$SKIP_AGENT" = "1" ]; then
  log "skipping agent CLI install (--skip-agent)"
elif have omp; then
  log "omp already installed: $(omp --version 2>/dev/null | head -n1 || true)"
else
  log "installing the coding agent CLI (${AGENT_PACKAGE})"
  npm install -g "$AGENT_PACKAGE"
fi

log "verifying installed tools"
STATUS=0
TOOLS="node pnpm git gh"
if [ "$SKIP_AGENT" != "1" ]; then
  TOOLS="$TOOLS omp"
fi
for tool in $TOOLS; do
  if have "$tool"; then
    version="$("$tool" --version 2>/dev/null | head -n1 || true)"
    log "  $tool: ok ${version}"
  else
    log "  $tool: MISSING"
    STATUS=1
  fi
done

if [ "$STATUS" = "0" ]; then
  log "done. Next: pnpm install && pnpm build && node dist/cli.js doctor (see README Setup)"
else
  echo "error: some tools are still missing; see output above" >&2
fi
exit "$STATUS"
