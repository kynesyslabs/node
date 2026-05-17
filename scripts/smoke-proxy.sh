#!/usr/bin/env bash
# smoke-proxy.sh — Epic 12 T13 smoke-test for every proxied route.
#
# Runs against a live `docker compose --profile proxy up` deployment and
# walks each route end-to-end. Pass/fail per check, plus a final summary.
# Use BEFORE dropping the redundant host port mappings to make sure no
# route silently breaks.
#
# Usage:
#   PROXY_DOMAIN=node.example.com ./scripts/smoke-proxy.sh
#   PROXY_DOMAIN=localhost CADDY_INSECURE=1 ./scripts/smoke-proxy.sh
#
# Env:
#   PROXY_DOMAIN              required — public DNS the proxy serves
#   CADDY_INSECURE            set to 1 to accept Caddy's local self-signed
#                             cert (for PROXY_DOMAIN=localhost dev)
#   METRICS_BASIC_AUTH_USER   username for /metrics (default: metrics)
#   METRICS_BASIC_AUTH_PASS   password for /metrics (optional — skips check if unset)
#   MCP_BASIC_AUTH_USER       username for /mcp    (default: mcp)
#   MCP_BASIC_AUTH_PASS       password for /mcp    (optional — skips check if unset)
#   TLSNOTARY_PROXY_MODE      subpath|subdomain|direct (default: subpath)
#
# Exit code: 0 if every required check passes, 1 otherwise.

set -u

PROXY_DOMAIN="${PROXY_DOMAIN:-}"
if [[ -z "$PROXY_DOMAIN" ]]; then
    echo "PROXY_DOMAIN is required" >&2
    exit 2
fi

CURL=(curl --silent --show-error --location --max-time 10)
if [[ "${CADDY_INSECURE:-0}" == "1" ]]; then
    CURL+=(--insecure)
fi

BASE="https://$PROXY_DOMAIN"
PASS=0
FAIL=0
SKIP=0

ok()   { echo "[PASS] $*";     PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*" >&2; FAIL=$((FAIL + 1)); }
skip() { echo "[SKIP] $*";     SKIP=$((SKIP + 1)); }

http_status() {
    local url="$1"
    shift
    "${CURL[@]}" "$@" --output /dev/null --write-out "%{http_code}" "$url"
}

echo "Smoke test against $BASE"
echo "----------------------------------------------------------------"

# 1. RPC root
code=$(http_status "$BASE/")
if [[ "$code" == "200" ]]; then
    ok "RPC root  -> 200"
else
    fail "RPC root  -> $code (expected 200)"
fi

# 2. /health extended JSON
body=$("${CURL[@]}" "$BASE/health" || true)
if echo "$body" | grep -q '"status"'; then
    status=$(echo "$body" | sed -n 's/.*"status":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    case "$status" in
        ok|degraded|dormant) ok "RPC /health -> status=$status";;
        failing)             fail "RPC /health -> status=failing";;
        *)                   fail "RPC /health -> unknown status '$status'";;
    esac
else
    fail "RPC /health did not return extended JSON (Epic 13 T7 missing?)"
fi

# 3. /health/subsystems
code=$(http_status "$BASE/health/subsystems")
if [[ "$code" == "200" ]]; then
    ok "/health/subsystems -> 200"
else
    fail "/health/subsystems -> $code"
fi

# 4. /metrics basic-auth
code=$(http_status "$BASE/metrics")
if [[ "$code" == "401" ]]; then
    ok "/metrics unauthenticated -> 401"
else
    fail "/metrics unauthenticated -> $code (expected 401)"
fi
if [[ -n "${METRICS_BASIC_AUTH_PASS:-}" ]]; then
    user="${METRICS_BASIC_AUTH_USER:-metrics}"
    code=$(http_status "$BASE/metrics" --user "$user:$METRICS_BASIC_AUTH_PASS")
    if [[ "$code" == "200" ]]; then
        ok "/metrics authenticated   -> 200"
    else
        fail "/metrics authenticated   -> $code"
    fi
else
    skip "/metrics authenticated   (set METRICS_BASIC_AUTH_PASS)"
fi

# 5. /mcp basic-auth
code=$(http_status "$BASE/mcp/sse")
if [[ "$code" == "401" ]]; then
    ok "/mcp unauthenticated -> 401"
else
    fail "/mcp unauthenticated -> $code (expected 401)"
fi
if [[ -n "${MCP_BASIC_AUTH_PASS:-}" ]]; then
    user="${MCP_BASIC_AUTH_USER:-mcp}"
    out=$("${CURL[@]}" --user "$user:$MCP_BASIC_AUTH_PASS" \
                       --output /dev/null --write-out "%{http_code}" \
                       --max-time 3 \
                       "$BASE/mcp/sse" 2>&1 | tail -1)
    if [[ "$out" == "200" ]]; then
        ok "/mcp authenticated   -> 200"
    else
        fail "/mcp authenticated   -> $out"
    fi
else
    skip "/mcp authenticated   (set MCP_BASIC_AUTH_PASS)"
fi

# 6. Grafana sub-path
code=$(http_status "$BASE/grafana/api/health")
if [[ "$code" == "200" ]]; then
    ok "/grafana/api/health -> 200"
else
    fail "/grafana/api/health -> $code"
fi

# 7. Prometheus sub-path
code=$(http_status "$BASE/prometheus/-/healthy")
if [[ "$code" == "200" ]]; then
    ok "/prometheus/-/healthy -> 200"
else
    fail "/prometheus/-/healthy -> $code"
fi

# 8. Signaling WS endpoint reachability
code=$(http_status "$BASE/signaling/")
if [[ "$code" == "500" || "$code" == "426" || "$code" == "400" ]]; then
    ok "/signaling/ reaches backend (got $code on plain GET — expected for WS-only endpoint)"
else
    fail "/signaling/ -> $code (expected 426/500/400 for non-upgrade GET)"
fi

# 9. TLSNotary — depends on mode
mode="${TLSNOTARY_PROXY_MODE:-subpath}"
case "$mode" in
    subpath)
        code=$(http_status "$BASE/tlsnotary/info")
        if [[ "$code" == "200" || "$code" == "404" ]]; then
            ok "/tlsnotary/info reaches backend (got $code)"
        else
            fail "/tlsnotary/info -> $code"
        fi
        ;;
    subdomain)
        code=$(http_status "https://notary.$PROXY_DOMAIN/info")
        if [[ "$code" == "200" || "$code" == "404" ]]; then
            ok "notary.$PROXY_DOMAIN/info -> $code"
        else
            fail "notary.$PROXY_DOMAIN/info -> $code"
        fi
        ;;
    direct)
        skip "TLSNotary (direct mode — not proxied; verify host:7047 manually)"
        ;;
    *)
        fail "Unknown TLSNOTARY_PROXY_MODE=$mode"
        ;;
esac

# 10. Spoofed XFF should not 429 or affect status
spoofed=$(http_status "$BASE/health" --header "X-Forwarded-For: 6.6.6.6")
if [[ "$spoofed" == "200" ]]; then
    ok "Spoofed XFF accepted at edge (Caddy strips before forwarding)"
else
    fail "Spoofed XFF caused $spoofed (expected 200; Caddy or node misconfigured)"
fi

echo "----------------------------------------------------------------"
echo "Summary: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
