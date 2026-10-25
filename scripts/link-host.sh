#!/usr/bin/env bash
# Point .omp-host at the omp checkout the plugins are typechecked and tested against.
# Usage: scripts/link-host.sh <path-to-omp-checkout>   (or set OMP_HOST)
set -euo pipefail
cd "$(dirname "$0")/.."
host="${1:-${OMP_HOST:-}}"
if [[ -z "$host" ]]; then
	echo "usage: scripts/link-host.sh <path-to-omp-checkout> (or set OMP_HOST)" >&2
	exit 2
fi
ln -sfn "$host" .omp-host
echo ".omp-host -> $(readlink .omp-host)"
