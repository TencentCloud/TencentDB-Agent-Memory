#!/bin/sh
set -e

# Knowledge Service image entrypoint.
#
# Dockerfile CMD defaults to ["start"]; docker-compose overrides it with
# server CLI flags (e.g. --public-url=… --tmc-callback=…). Both are forwarded
# to the server below. dist/server.js is the tsdown build of src/server.ts
# (the bin/*.mjs launchers are only used for npm global installs and are not
# part of the image).

if [ "$1" = "start" ]; then
  shift
fi

exec node /app/dist/server.js "$@"
