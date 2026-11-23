#!/bin/sh
set -eu

mkdir -p "$UNLIMITEDCODE_HOME" /app/logs

# The rotating egress proxy lives in this same container so zen-proxy can reach
# it on loopback regardless of Docker/host firewall rules.
/usr/local/bin/unlimitedcode daemon --parent-pid 1 > /app/logs/daemon.log 2>&1 &

ready=0
i=0
while [ "$i" -lt 300 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:42988/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

if [ "$ready" -ne 1 ]; then
  echo "unlimitedcode daemon failed to start" >&2
  cat /app/logs/daemon.log >&2
  exit 1
fi

echo "egress proxy ready on 127.0.0.1:42987"
exec bun /app/run.mjs
