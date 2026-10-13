#!/bin/bash

set -e

if [ -n "$DOMAIN" ] &&
  [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ] &&
  [ -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]; then
  echo "Existing certificate found for ${DOMAIN}; skipping DNS bootstrap"
  touch /.bootstrapped
fi

# Optional request body cap. nginx.conf includes conf.d/*.conf in the http block
# and the generated default.conf sets none, so this replaces nginx's 1m default.
# Unset: no file is written and nginx keeps its 1m default.
BODY_SIZE_CONF=/etc/nginx/conf.d/client-max-body-size.conf
rm -f "$BODY_SIZE_CONF"
if [ -n "${CLIENT_MAX_BODY_SIZE:-}" ]; then
  if ! [[ "$CLIENT_MAX_BODY_SIZE" =~ ^[1-9][0-9]*[kKmM]?$ ]]; then
    echo "Error: CLIENT_MAX_BODY_SIZE='${CLIENT_MAX_BODY_SIZE}' must be a positive integer with an optional k/m suffix (e.g. 2m)" >&2
    exit 1
  fi
  echo "client_max_body_size ${CLIENT_MAX_BODY_SIZE};" >"$BODY_SIZE_CONF"
  echo "client_max_body_size set to ${CLIENT_MAX_BODY_SIZE}"
fi

exec /scripts/entrypoint-original.sh "$@"
