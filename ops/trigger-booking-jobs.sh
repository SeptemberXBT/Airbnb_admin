#!/bin/sh
set -eu

: "${APP_URL:?APP_URL is required}"
: "${BOOKING_CRON_SECRET:?BOOKING_CRON_SECRET is required}"

curl --fail --silent --show-error \
  --max-time 55 \
  --retry 2 \
  --retry-delay 5 \
  --request POST \
  --config - <<EOF
header = "Authorization: Bearer ${BOOKING_CRON_SECRET}"
url = "${APP_URL%/}/api/bookings/cron"
EOF
