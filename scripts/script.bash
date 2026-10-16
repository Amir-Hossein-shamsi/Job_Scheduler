#!/usr/bin/env bash
set -euo pipefail

echo "Hello from the job scheduler!"
echo "Hi this is a bash TEST"

if [[ $# -gt 0 ]]; then
  echo "Args: $*"
fi