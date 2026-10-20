#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — pull the latest rara-agent image from GHCR + restart the stack.
#
# Usage (run on your Docker host):
#   bash deploy.sh           # pull + restart
#   bash deploy.sh logs      # tail logs after restart
#   bash deploy.sh status    # show container status
#   bash deploy.sh rollback  # rollback to previous image tag
#
# Requires: docker + docker compose plugin.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACTION="${1:-pull-restart}"

case "$ACTION" in
  pull-restart|"")
    echo "── Pulling latest rara-agent image from GHCR ──"
    docker compose pull
    echo
    echo "── Restarting stack (zero-downtime) ──"
    docker compose up -d --remove-orphans
    echo
    echo "── Container status ──"
    docker compose ps
    echo
    echo "✓ Deployed. Tail logs with: bash deploy.sh logs"
    ;;

  logs)
    docker compose logs -f rara
    ;;

  status)
    docker compose ps
    echo
    echo "── Recent log lines ──"
    docker compose logs --tail=20 rara
    ;;

  rollback)
    # Roll back to the previous image tag.
    echo "── Available image tags (most recent first) ──"
    docker image ls ghcr.io/yz776/rara-agent | head -10
    echo
    read -r -p "Enter tag to roll back to (e.g. sha-XXXXXXXX): " TAG
    if [ -z "$TAG" ]; then
      echo "No tag entered. Aborting."
      exit 1
    fi
    # Pin the image tag in docker-compose.override.yml
    cat > docker-compose.override.yml <<EOF
services:
  rara:
    image: ghcr.io/yz776/rara-agent:$TAG
    pull_policy: missing
EOF
    echo "── Rolling back to $TAG ──"
    docker compose up -d --remove-orphans
    echo
    echo "✓ Rolled back. Delete docker-compose.override.yml to use latest again."
    ;;

  *)
    echo "Usage: bash deploy.sh [pull-restart|logs|status|rollback]"
    exit 1
    ;;
esac
