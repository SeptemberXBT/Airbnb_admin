#!/bin/sh
set -eu

: "${APP_URL:?APP_URL is required}"
: "${SYNC_SECRET:?SYNC_SECRET is required}"

curl --fail --silent --show-error \
  --max-time 70 \
  --retry 2 \
  --retry-delay 5 \
  --request POST \
  --config - <<EOF
header = "Authorization: Bearer ${SYNC_SECRET}"
url = "${APP_URL%/}/api/sync/cron"
EOF
