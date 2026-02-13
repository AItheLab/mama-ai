#!/bin/bash
# Install Mama AI Agent
# Usage: curl -sSL https://mama.dev/install | bash

set -euo pipefail

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required (22+)."
    exit 1
  fi

  local version
  version="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$version" -lt 22 ]]; then
    echo "Node.js 22+ is required. Found $(node -v)."
    exit 1
  fi
}

check_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  echo "pnpm is required. Installing via corepack..."
  corepack enable
  corepack prepare pnpm@10.24.0 --activate
}

check_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    return
  fi
  echo "Warning: Ollama not found. You can still configure cloud-hosted models."
}

install_mama() {
  pnpm add -g mama-agent
}

initialize_mama() {
  mama init
}

main() {
  check_node_version
  check_pnpm
  check_ollama
  install_mama
  initialize_mama
  echo "Mama is ready. Run 'mama chat' to start."
}

main "$@"
