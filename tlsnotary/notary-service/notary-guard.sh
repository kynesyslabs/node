#!/bin/sh
# Start guard of the Demos TLSNotary notary.
#
# The stock notary-server signs with a random key that changes on every
# restart when its key file is not set, and it attests whatever time its
# clock says (TLSN design 2.5, F0 and F9). Either would make every
# attestation it signs useless or refused on chain, without any error at the
# notary. This guard therefore refuses to start the notary unless the key
# file and the clock are right.
#
#   notary-guard.sh preflight
#       On the host, before every start (systemd ExecStartPre). Checks the key
#       file NOTARY_KEY_FILE and that the host clock is NTP-synchronised, then
#       writes the stamp NOTARY_STAMP_FILE ("<epoch> <public key>").
#
#   notary-guard.sh exec [--] <command> [args...]
#       Inside the container, as its entrypoint. Checks the key file the
#       notary will load (NS_NOTARIZATION__PRIVATE_KEY_PATH) and that the
#       stamp is fresh and names the same key, then execs <command>. A
#       container cannot read the host's NTP state, so the stamp carries the
#       host check in; a container started without the preflight (a bare
#       `docker compose up`, a `docker start` long after) does not start.
#
# Settings (environment):
#   NOTARY_EXPECTED_PUBKEY       required: the key's 33-byte compressed public
#                                key, lowercase hex, as the fork payload lists it
#   NOTARY_KEY_FILE              preflight: the key file on the host
#   NOTARY_UID, NOTARY_GID       preflight: the container user (default
#                                10001); the key file must be its own, or its
#                                group's with group read
#   NOTARY_STAMP_FILE            stamp path (default $NOTARY_STAMP_DIR/clock.ok,
#                                NOTARY_STAMP_DIR defaulting to /run/tlsn-notary)
#   NOTARY_STAMP_MAX_AGE_SEC     exec: oldest stamp accepted (default 300)
#   NOTARY_MAX_CLOCK_OFFSET_SEC  preflight: largest NTP offset (default 30)
#   NOTARY_BIND                  preflight: host address the port is published
#                                on; every-interface addresses are refused
#   NOTARY_ALLOW_UNSYNCED_CLOCK  1 skips the clock and stamp checks. Local
#                                development only; never set on a notary
#                                whose key a genesis lists.
#
# Exit codes:
#   0  preflight passed (exec mode replaces itself with <command>)
#   2  usage or configuration error
#   3  key file missing, not a regular file, unreadable (by the container
#      user, in the preflight) or oversized
#   4  key file readable by others, or writable by its group or others
#   5  key file is not a PKCS#8 secp256k1 private key with its public key
#   6  key file holds another key than NOTARY_EXPECTED_PUBKEY
#   7  clock not NTP-synchronised or too far off, or the preflight stamp is
#      missing, stale or for another key

set +x
set -u

NOTARY_SERVICE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "${NOTARY_SERVICE_DIR}/lib.sh"

refuse() {
    _code=$1
    shift
    notary_log "REFUSING TO START: $*"
    exit "${_code}"
}

check_key_file() {
    _key=$1
    [ -n "${_key}" ] || refuse 2 "no key file is configured"
    [ -e "${_key}" ] || refuse 3 "key file ${_key} does not exist; the notary would sign with a random key"
    [ -f "${_key}" ] || refuse 3 "key file ${_key} is not a regular file"
    [ -r "${_key}" ] || refuse 3 "key file ${_key} is not readable by uid $(id -u)"
    _size=$(wc -c < "${_key}" 2>/dev/null | tr -d " ") || refuse 3 "key file ${_key} cannot be read"
    [ "${_size}" -gt 0 ] && [ "${_size}" -le 4096 ] || refuse 3 "key file ${_key} is ${_size} bytes; a PKCS#8 secp256k1 key is about 240"
    _mode=$(stat -c '%a' "${_key}") || refuse 3 "cannot stat ${_key}"
    # Others get nothing, the group may at most read (a 0440 file shared with
    # the container's group)
    if [ $((0${_mode} & 07)) -ne 0 ] || [ $((0${_mode} & 020)) -ne 0 ]; then
        refuse 4 "key file ${_key} has mode ${_mode}; make it 0400 or 0440 (chmod 0400 ${_key})"
    fi
    # The preflight runs as root, for whom any file is readable; the
    # container reads the key as NOTARY_UID:NOTARY_GID.
    if [ -n "${2:-}" ]; then
        _owner=$(stat -c '%u' "${_key}")
        _group=$(stat -c '%g' "${_key}")
        if [ "${_owner}" != "$2" ] && { [ "${_group}" != "${3:-}" ] || [ $((0${_mode} & 040)) -eq 0 ]; }; then
            refuse 3 "key file ${_key} is owned by ${_owner}:${_group} with mode ${_mode}; the notary runs as $2:${3:-} and could not read it (chown $2:${3:-$2} ${_key})"
        fi
    fi
    _pub=$(k256_pkcs8_pubkey "${_key}") ||
        refuse 5 "key file ${_key} is not an unencrypted PKCS#8 secp256k1 private key with its public key (the form notary-key-ceremony.sh writes)"
    [ "${_pub}" = "${NOTARY_EXPECTED_PUBKEY}" ] ||
        refuse 6 "key file ${_key} holds public key ${_pub} ($(key_fingerprint "${_pub}")), expected ${NOTARY_EXPECTED_PUBKEY}"
}

clock_override() {
    [ "${NOTARY_ALLOW_UNSYNCED_CLOCK:-0}" = 1 ]
}

warn_override() {
    notary_log "WARNING: clock checks skipped (NOTARY_ALLOW_UNSYNCED_CLOCK=1); local development only"
}

mode=${1:-}
[ $# -gt 0 ] && shift

NOTARY_EXPECTED_PUBKEY=${NOTARY_EXPECTED_PUBKEY:-}
is_compressed_pubkey "${NOTARY_EXPECTED_PUBKEY}" ||
    refuse 2 "NOTARY_EXPECTED_PUBKEY must be the 33-byte compressed secp256k1 public key, lowercase 02 or 03 + 64 hex"
STAMP=${NOTARY_STAMP_FILE:-${NOTARY_STAMP_DIR:-/run/tlsn-notary}/clock.ok}

case ${mode} in
    preflight)
        case ${NOTARY_BIND:-127.0.0.1} in
            0.0.0.0 | '::' | '[::]' | '*')
                refuse 2 "NOTARY_BIND=${NOTARY_BIND} publishes the notary on every interface; bind it to loopback or a private address behind the TLS reverse proxy" ;;
        esac
        check_key_file "${NOTARY_KEY_FILE:-}" "${NOTARY_UID:-10001}" "${NOTARY_GID:-10001}"
        mkdir -p "$(dirname -- "${STAMP}")" || refuse 2 "cannot create $(dirname -- "${STAMP}")"
        if clock_override; then
            warn_override
        else
            max=${NOTARY_MAX_CLOCK_OFFSET_SEC:-30}
            clock_status
            problem=$(clock_problem "${max}")
            [ -z "${problem}" ] || refuse 7 "${problem}"
            printf '%s %s\n' "$(date -u +%s)" "${NOTARY_EXPECTED_PUBKEY}" > "${STAMP}.tmp" &&
                chmod 0644 "${STAMP}.tmp" && mv -f "${STAMP}.tmp" "${STAMP}" ||
                refuse 2 "cannot write the stamp ${STAMP}"
        fi
        notary_log "preflight passed: key $(key_fingerprint "${NOTARY_EXPECTED_PUBKEY}")"
        exit 0
        ;;
    exec)
        [ "${1:-}" = "--" ] && shift
        [ $# -gt 0 ] || refuse 2 "usage: notary-guard.sh exec [--] <command> [args...]"
        check_key_file "${NS_NOTARIZATION__PRIVATE_KEY_PATH:-}"
        if clock_override; then
            warn_override
        else
            [ -r "${STAMP}" ] ||
                refuse 7 "no preflight stamp at ${STAMP}; start the notary through its systemd unit, which runs 'notary-guard.sh preflight' first"
            read -r stamp_time stamp_key < "${STAMP}" || refuse 7 "cannot read the preflight stamp ${STAMP}"
            case ${stamp_time} in
                '' | *[!0-9]*) refuse 7 "malformed preflight stamp ${STAMP}" ;;
            esac
            age=$(($(date -u +%s) - stamp_time))
            max_age=${NOTARY_STAMP_MAX_AGE_SEC:-300}
            [ "${age}" -ge -5 ] && [ "${age}" -le "${max_age}" ] ||
                refuse 7 "the preflight stamp ${STAMP} is ${age} s old (limit ${max_age} s); run the preflight again"
            [ "${stamp_key}" = "${NOTARY_EXPECTED_PUBKEY}" ] ||
                refuse 7 "the preflight stamp ${STAMP} was written for key ${stamp_key}, not ${NOTARY_EXPECTED_PUBKEY}"
        fi
        notary_log "key $(key_fingerprint "${NOTARY_EXPECTED_PUBKEY}") checked, starting $1"
        exec "$@"
        ;;
    *)
        refuse 2 "usage: notary-guard.sh preflight | notary-guard.sh exec [--] <command> [args...]"
        ;;
esac
