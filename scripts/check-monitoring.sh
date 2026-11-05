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
# Critical and page go to slack AND paging, warning and info to slack only, the
# heartbeat to deadman only. --verify.receivers needs the exact list of receivers the
# alert reaches, in route order (paging first, then slack), so "slack only" also fails
# if paging is added by mistake.
route() {
    local receivers="$1"; shift
    "$amtool" config routes test --config.file="$mon/alertmanager/alertmanager.yml" \
        --verify.receivers="$receivers" "$@" >/dev/null \
        && echo "ok   $* -> $receivers"
}
route paging,slack severity=critical alertname=NodeDown instance=validator-1
route paging,slack severity=critical alertname=ConflictingBlock
route paging,slack severity=critical alertname=ForeignSignature
route paging,slack severity=critical alertname=PrecommitEquivocation
route paging,slack severity=page alertname=Anything
route slack        severity=warning alertname=DiskSpaceLow
route slack        severity=info alertname=PortDriftDetected
route blackhole     severity=info alertname=MissedSignatures
route deadman      severity=none alertname=DeadMansSwitch
