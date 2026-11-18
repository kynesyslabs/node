#!/bin/sh
# Health check of a Demos TLSNotary notary, for cron or a systemd timer.
#
# Checks that the notary answers, that the key it serves is the pinned one
# (a notary that lost its key file signs with a random key, F0), and that
# the host clock is synchronised and well inside the fork's futureSkewSec
# (a notary ahead of the chain's clock attests times nodes refuse, F9).
# One line per check on stdout; the exit code names the first failure.
#
# Settings (environment):
#   NOTARY_EXPECTED_PUBKEY       required: the pinned compressed public key
#   NOTARY_URL                   base URL (default http://127.0.0.1:7047)
#   NOTARY_MAX_CLOCK_OFFSET_SEC  largest NTP offset (default 30, half of the
#                                mainnet futureSkewSec)
#   NOTARY_FUTURE_SKEW_SEC       the fork's futureSkewSec (default 60); the
#                                offset limit must stay below it
#   NOTARY_CHECK_TIMEOUT_SEC     per request (default 5)
#
# Exit codes:
#   0  healthy
#   1  usage or configuration error, or a tool is missing
#   2  notary unreachable or unhealthy
#   3  served key is not the pinned key, or cannot be read
#   4  clock not NTP-synchronised, or offset at or above the limit

set -u

NOTARY_SERVICE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "${NOTARY_SERVICE_DIR}/lib.sh"

URL=${NOTARY_URL:-http://127.0.0.1:7047}
URL=${URL%/}
TIMEOUT=${NOTARY_CHECK_TIMEOUT_SEC:-5}
MAX_OFFSET=${NOTARY_MAX_CLOCK_OFFSET_SEC:-30}
SKEW=${NOTARY_FUTURE_SKEW_SEC:-60}
EXPECTED=${NOTARY_EXPECTED_PUBKEY:-}

config_error() {
    printf 'CONFIG %s\n' "$*"
    exit 1
}

is_compressed_pubkey "${EXPECTED}" ||
    config_error "NOTARY_EXPECTED_PUBKEY must be the 33-byte compressed secp256k1 public key, lowercase 02 or 03 + 64 hex"
command -v curl >/dev/null 2>&1 || config_error "curl is not installed"
abs_below "${MAX_OFFSET}" "${SKEW}" ||
    config_error "NOTARY_MAX_CLOCK_OFFSET_SEC=${MAX_OFFSET} must be below futureSkewSec ${SKEW}"

result=0
fail() {
    [ "${result}" -ne 0 ] || result=$1
    shift
    printf 'FAIL %s\n' "$*"
}

# 1. reachable and healthy
if curl -fsS -m "${TIMEOUT}" -o /dev/null "${URL}/healthcheck" 2>/dev/null; then
    printf 'OK   reachable %s\n' "${URL}"
    reachable=1
else
    fail 2 "unreachable: ${URL}/healthcheck did not answer 200 within ${TIMEOUT} s"
    reachable=0
fi

# 2. the served key is the pinned key
if [ "${reachable}" = 1 ]; then
    info=$(curl -fsS -m "${TIMEOUT}" "${URL}/info" 2>/dev/null)
    b64=$(printf '%s' "${info}" |
        sed -n 's/.*"publicKey":"-----BEGIN PUBLIC KEY-----\(.*\)-----END PUBLIC KEY-----.*/\1/p' |
        sed 's/\\n//g' | tr -d ' \r\n')
    served=
    if [ -n "${b64}" ] && printf '%s' "${b64}" | base64 -d >/dev/null 2>&1; then
        served=$(k256_spki_pubkey "$(printf '%s' "${b64}" | base64 -d | od -An -v -tx1 | tr -d ' \n')")
    fi
    if [ -z "${served}" ]; then
        fail 3 "key: /info served no secp256k1 public key"
    elif [ "${served}" != "${EXPECTED}" ]; then
        fail 3 "key: served ${served} ($(key_fingerprint "${served}")), pinned ${EXPECTED}; the notary is not signing with the pinned key"
    else
        printf 'OK   key %s %s\n' "${served}" "$(key_fingerprint "${served}")"
    fi
fi

# 3. the host clock
clock_status
problem=$(clock_problem "${MAX_OFFSET}")
if [ -n "${problem}" ]; then
    fail 4 "clock: ${problem}"
else
    printf 'OK   clock synchronised (%s), offset %s s, limit %s s\n' "${CLOCK_SOURCE}" "${CLOCK_OFFSET:-unknown}" "${MAX_OFFSET}"
fi

exit "${result}"
