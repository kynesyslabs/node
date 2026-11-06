#!/usr/bin/env bash
# Checks the Prometheus alert rules and the Alertmanager routing in monitoring/.
# Needs promtool (from the Prometheus release) and amtool (from the Alertmanager
# release) on PATH, or set PROMTOOL / AMTOOL to their paths.
#
#   scripts/check-monitoring.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mon="$root/monitoring"
promtool="${PROMTOOL:-promtool}"
amtool="${AMTOOL:-amtool}"

for tool in "$promtool" "$amtool"; do
    command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

echo "== promtool check config"
"$promtool" check config "$mon/prometheus/prometheus.yml"

echo "== promtool check rules"
"$promtool" check rules "$mon"/prometheus/alerts/*.yml

echo "== promtool test rules"
"$promtool" test rules "$mon"/prometheus/tests/*.test.yml

echo "== amtool check-config"
"$amtool" check-config "$mon/alertmanager/alertmanager.yml"

echo "== amtool routing"
# Critical and page go to paging, warning and info to slack, the heartbeat to deadman.
route() {
    local receiver="$1"; shift
    "$amtool" config routes test --config.file="$mon/alertmanager/alertmanager.yml" \
        --verify.receivers="$receiver" "$@" >/dev/null \
        && echo "ok   $* -> $receiver"
}
route paging  severity=critical alertname=NodeDown instance=validator-1
route paging  severity=page alertname=Anything
route paging  severity=critical alertname=ConflictingBlock
route slack   severity=warning alertname=DiskSpaceLow
route slack   severity=info alertname=PortDriftDetected
route deadman severity=none alertname=DeadMansSwitch
