#!/bin/sh
# Notary key ceremony: makes one secp256k1 notary signing key, offline.
#
#   notary-key-ceremony.sh --id <key-id> --recipient <age1...> --recipient <age1...> \
#       --out-dir <dir> [--allow-online]
#
# The private key is written only SOPS-encrypted to the age recipients given
# (one per key holder, at least two, so the key survives the loss of one
# holder). It is generated in a private temporary directory (RAM-backed when
# /dev/shm is writable), never printed, and wiped on exit. What leaves the
# ceremony:
#
#   <out-dir>/<id>.key.sops.json     the encrypted private key, for the holders
#   <out-dir>/<id>.notary-key.json   {"id","alg":"k256","hex"}: the entry for
#                                    notaryKeys of the tlsnVerified fork payload
#                                    and the SDK pins
#   stdout                           that entry, the public key and its
#                                    fingerprint, for the holders to publish
#
# Without --allow-online it refuses to run on a host with a default route,
# so a production key is made offline. --allow-online is for rehearsal keys.
#
# Exit codes: 0 done, 2 usage, 3 a tool is missing, 4 the host is online,
# 5 the outputs already exist, 6 generation or encryption failed.

set -u
set +x

NOTARY_SERVICE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
NOTARY_LOG_TAG=notary-key-ceremony
# shellcheck source=lib.sh
. "${NOTARY_SERVICE_DIR}/lib.sh"

usage() {
    notary_log "$*"
    notary_log "usage: notary-key-ceremony.sh --id <key-id> --recipient <age1...> --recipient <age1...> --out-dir <dir> [--allow-online]"
    exit 2
}

ID=
OUT=
RECIPIENTS=
ALLOW_ONLINE=0
while [ $# -gt 0 ]; do
    case $1 in
        --id) [ $# -ge 2 ] || usage "--id needs a value"; ID=$2; shift 2 ;;
        --recipient) [ $# -ge 2 ] || usage "--recipient needs a value"; RECIPIENTS="${RECIPIENTS} $2"; shift 2 ;;
        --out-dir) [ $# -ge 2 ] || usage "--out-dir needs a value"; OUT=$2; shift 2 ;;
        --allow-online) ALLOW_ONLINE=1; shift ;;
        *) usage "unknown argument $1" ;;
    esac
done

# The fork payload's key id rule (src/forks/tlsnVerifiedPayload.ts)
printf '%s' "${ID}" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' ||
    usage "--id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}, as notaryKeys[].id does"
[ -n "${OUT}" ] || usage "--out-dir is required"

count=0
seen=
for r in ${RECIPIENTS}; do
    printf '%s' "${r}" | grep -Eqx 'age1[02-9ac-hj-np-z]{58}' || usage "--recipient ${r} is not an age X25519 recipient (age1...)"
    case " ${seen} " in *" ${r} "*) usage "--recipient ${r} is given twice" ;; esac
    seen="${seen} ${r}"
    count=$((count + 1))
done
[ "${count}" -ge 2 ] || usage "give at least two --recipient, one per key holder"

for tool in openssl sops od sha256sum; do
    command -v "${tool}" >/dev/null 2>&1 || { notary_log "${tool} is not installed"; exit 3; }
done

if [ "${ALLOW_ONLINE}" != 1 ]; then
    online=
    [ -r /proc/net/route ] && awk 'NR > 1 && $2 == "00000000" { found = 1 } END { exit !found }' /proc/net/route && online=IPv4
    [ -r /proc/net/ipv6_route ] && awk '$1 == "00000000000000000000000000000000" && $2 == "00" && $10 != "lo" { found = 1 } END { exit !found }' /proc/net/ipv6_route && online="${online} IPv6"
    if [ -n "${online}" ]; then
        notary_log "this host has a default route (${online}); make a production notary key offline, or pass --allow-online for a rehearsal key"
        exit 4
    fi
fi

ENC="${OUT}/${ID}.key.sops.json"
ENTRY="${OUT}/${ID}.notary-key.json"
mkdir -p "${OUT}" || exit 6
for f in "${ENC}" "${ENTRY}"; do
    [ ! -e "${f}" ] || { notary_log "${f} already exists; a key id is made once"; exit 5; }
done

umask 077
base=${TMPDIR:-/tmp}
[ -d /dev/shm ] && [ -w /dev/shm ] && base=/dev/shm
WORK=$(mktemp -d "${base}/notary-ceremony.XXXXXXXX") || exit 6

wipe() {
    if [ -n "${WORK:-}" ] && [ -d "${WORK}" ]; then
        for f in "${WORK}"/*; do
            [ -f "${f}" ] || continue
            if command -v shred >/dev/null 2>&1; then
                shred -u -z "${f}" 2>/dev/null || rm -f "${f}"
            else
                dd if=/dev/zero of="${f}" bs=1k count=4 conv=notrunc 2>/dev/null
                rm -f "${f}"
            fi
        done
        rm -rf "${WORK}"
    fi
}
trap wipe EXIT
trap 'exit 6' INT TERM HUP

failed() {
    notary_log "$*"
    rm -f "${ENC}" "${ENC}.tmp" "${ENTRY}"
    exit 6
}

KEY="${WORK}/notary.key"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp256k1 -out "${KEY}" 2>/dev/null ||
    failed "openssl could not generate a secp256k1 key"
openssl pkey -in "${KEY}" -check -noout >/dev/null 2>&1 || failed "the generated key fails openssl's key check"

# The same parser the notary's start guard uses, cross-checked against the
# public key openssl derives from the scalar.
PUB=$(k256_pkcs8_pubkey "${KEY}") || failed "the generated key is not in the layout the start guard accepts"
DERIVED=$(openssl pkey -in "${KEY}" -pubout -outform DER -ec_conv_form compressed 2>/dev/null | tail -c 33 | od -An -v -tx1 | tr -d ' \n')
[ "${PUB}" = "${DERIVED}" ] || failed "the embedded and the derived public key differ"
is_compressed_pubkey "${PUB}" || failed "unexpected public key form"

# An explicit --config with one catch-all rule naming only the holders
# given here, so a .sops.yaml in or above the working directory cannot add
# or swap recipients.
AGE_LIST=$(printf '%s' "${seen# }" | tr ' ' ',')
printf 'creation_rules:\n  - age: "%s"\n' "${AGE_LIST}" > "${WORK}/sops.yaml"
sops --config "${WORK}/sops.yaml" --encrypt --input-type binary --output-type json \
    "${KEY}" > "${ENC}.tmp" 2>"${WORK}/sops.err" || failed "sops could not encrypt: $(head -c 300 "${WORK}/sops.err")"
grep -q 'PRIVATE KEY' "${ENC}.tmp" && failed "the encrypted file holds the key in plain text"
for r in ${seen}; do
    grep -q "${r}" "${ENC}.tmp" || failed "the encrypted file does not name recipient ${r}"
done
mv "${ENC}.tmp" "${ENC}" || failed "cannot write ${ENC}"

printf '{"id":"%s","alg":"k256","hex":"%s"}\n' "${ID}" "${PUB}" > "${ENTRY}" || failed "cannot write ${ENTRY}"
chmod 0644 "${ENTRY}" "${ENC}"

FP=$(key_fingerprint "${PUB}")
printf 'notaryKeys entry: %s\n' "$(cat "${ENTRY}")"
printf 'public key:       %s\n' "${PUB}"
printf 'fingerprint:      %s\n' "${FP}"
printf 'encrypted key:    %s (%s holders)\n' "${ENC}" "${count}"
