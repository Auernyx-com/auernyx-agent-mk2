#!/bin/bash
# Publish this Worker: ./deploy.sh preview   (new version, no live traffic, health-checked)
#                      ./deploy.sh live      (only after Justin approved: switches to that exact version)
# Settings: worker.conf. Shared script: wyerd-site-kit/kit/deploy/worker-deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
exec "$HOME/projects/wyerd-site-kit/kit/deploy/worker-deploy.sh" "$@"
