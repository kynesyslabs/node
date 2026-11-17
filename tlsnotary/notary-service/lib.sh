# Shared helpers of the notary guard, the health check and the key ceremony.
# POSIX sh: the guard runs inside the stock notary-server image, which has
# sh, base64, od, awk, sed and stat but no openssl, curl or xxd.

# shellcheck shell=sh

# The guard and the ceremony read private keys; a trace (sh -x, SHELLOPTS)
# would copy them into a journal.
set +x

NOTARY_LOG_TAG=${NOTARY_LOG_TAG:-tlsn-notary}

notary_log() {
    printf '%s: %s\n' "${NOTARY_LOG_TAG}" "$*" >&2
}

# One line, no newline inside: grep -x alone matches line by line, so a
# value with an embedded newline could pass it.
single_line() {
    _s=$1
    [ "$(printf '%s' "${_s}" | wc -l | tr -d ' ')" = 0 ]
}

# A k256 notary key as the verifier reports it and the fork payload lists it.
is_compressed_pubkey() {
    _k=$1
    single_line "${_k}" && printf '%s' "${_k}" | grep -Eqx '0[23][0-9a-f]{64}'
}

# The DER of the PEM block labelled $2 in file $1, as lowercase hex, on
# stdout. The file must be that one block and nothing else: its first line
# the BEGIN line, its last non-empty line the END line, no other label, so
# an encrypted or SEC1 key, or text the notary's parser might reject, is
# refused here. Streams end to end so no secret is held in a variable.
pem_der_hex() {
    _file=$1
    _label=$2
    [ "$(grep -c -- '-----BEGIN ' "${_file}")" = 1 ] || return 1
    [ "$(grep -c -- '-----END ' "${_file}")" = 1 ] || return 1
    [ "$(head -n 1 "${_file}" | tr -d '\r')" = "-----BEGIN ${_label}-----" ] || return 1
    [ "$(grep -v '^[[:space:]]*$' "${_file}" | tail -n 1 | tr -d '\r')" = "-----END ${_label}-----" ] || return 1
    sed '1d;/^-----END /,$d' "${_file}" | tr -d ' \t\r\n' | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n'
}

# 04 || X || Y (130 hex) -> 02/03 || X, the form the fork payload pins.
compress_point() {
    _x=$(printf '%s' "$1" | cut -c3-66)
    _ylast=$(printf '%s' "$1" | cut -c130)
    case ${_ylast} in
        [02468ace]) printf '02%s' "${_x}" ;;
        *) printf '03%s' "${_x}" ;;
    esac
}

# The compressed public key embedded in a PKCS#8 secp256k1 private key file.
#
# Only the exact layout `openssl genpkey` writes is accepted: version 0,
# id-ecPublicKey with the secp256k1 OID, an ECPrivateKey with a 32-byte
# scalar, no inner parameters, and the public key present. The public key
# has to be there because this image has no EC arithmetic to derive it; the
# notary itself refuses a file whose embedded public key does not belong to
# the scalar (elliptic-curve's SEC1 import checks the pair), so the key
# checked here is the key the notary signs with.
k256_pkcs8_pubkey() {
    _keyfile=$1
    # Only the public point is ever captured; a failed or partial base64
    # decode cannot match the whole-DER pattern.
    _point=$(pem_der_hex "${_keyfile}" "PRIVATE KEY" |
        sed -n 's/^308184020100301006072a8648ce3d020106052b8104000a046d306b0201010420[0-9a-f]\{64\}a14403420004\([0-9a-f]\{128\}\)$/04\1/p')
    [ -n "${_point}" ] || return 1
    compress_point "${_point}"
}

# The compressed public key of a secp256k1 SubjectPublicKeyInfo given as DER
# hex, compressed or not, as /info serves it.
k256_spki_pubkey() {
    _c=$(printf '%s' "$1" | sed -n 's/^3036301006072a8648ce3d020106052b8104000a032200\(0[23][0-9a-f]\{64\}\)$/\1/p')
    if [ -n "${_c}" ]; then
        printf '%s' "${_c}"
        return 0
    fi
    _u=$(printf '%s' "$1" | sed -n 's/^3056301006072a8648ce3d020106052b8104000a034200\(04[0-9a-f]\{128\}\)$/\1/p')
    [ -n "${_u}" ] || return 1
    compress_point "${_u}"
}

# Raw bytes of a hex string on stdout, without xxd.
hex_to_bin() {
    _hex=$1
    _esc=$(printf '%s' "${_hex}" | awk '{
        h = "0123456789abcdef"; s = ""
        for (i = 1; i < length($0); i += 2) {
            v = (index(h, substr($0, i, 1)) - 1) * 16 + index(h, substr($0, i + 1, 1)) - 1
            s = s sprintf("\\%03o", v)
        }
        printf "%s", s
    }')
    # shellcheck disable=SC2059
    printf "${_esc}"
}

# SHA256:<hex> over the 33 key bytes. Holders publish it outside GitHub, as
# with the release keys, and the health check prints it for the served key.
key_fingerprint() {
    _fpkey=$1
    printf 'SHA256:%s' "$(hex_to_bin "${_fpkey}" | sha256sum | cut -c1-64)"
}

# |$1| < $2, both decimal seconds.
abs_below() {
    _val=$1
    _lim=$2
    awk -v o="${_val}" -v m="${_lim}" 'BEGIN { if (o < 0) o = -o; exit !(o + 0 < m + 0) }'
}

# Sets CLOCK_SYNCED (yes, no or unknown), CLOCK_OFFSET (signed seconds, empty
# when no source reports one) and CLOCK_SOURCE. The commands are variables so
# the tests can stand in for them.
clock_status() {
    _tdc=${NOTARY_TIMEDATECTL:-timedatectl}
    _chr=${NOTARY_CHRONYC:-chronyc}
    CLOCK_SYNCED=unknown
    CLOCK_OFFSET=
    CLOCK_SOURCE=none
    if command -v "${_tdc}" >/dev/null 2>&1; then
        case $("${_tdc}" show -p NTPSynchronized --value 2>/dev/null) in
            yes) CLOCK_SYNCED=yes; CLOCK_SOURCE=timedatectl ;;
            no) CLOCK_SYNCED=no; CLOCK_SOURCE=timedatectl ;;
            *) ;;
        esac
        # Only systemd-timesyncd answers timesync-status; units vary (us, ms, s).
        CLOCK_OFFSET=$("${_tdc}" timesync-status 2>/dev/null | awk '
            $1 == "Offset:" {
                v = $2; u = v; sub(/[a-zµ]+$/, "", v); sub(/^[-+0-9.]+/, "", u)
                f = (u == "s") ? 1 : (u == "ms") ? 0.001 : (u == "us" || u == "µs") ? 0.000001 : (u == "min") ? 60 : ""
                if (f != "") printf "%.6f", v * f
                exit
            }')
    fi
    if command -v "${_chr}" >/dev/null 2>&1; then
        _tracking=$("${_chr}" -n tracking 2>/dev/null)
        if [ -n "${_tracking}" ]; then
            # A leap second announcement is still a synchronised clock
            if printf '%s\n' "${_tracking}" | grep -Eq '^Leap status *: *(Normal|Insert second|Delete second)$'; then
                [ "${CLOCK_SYNCED}" = no ] || CLOCK_SYNCED=yes
            else
                CLOCK_SYNCED=no
            fi
            CLOCK_SOURCE=chronyc
            _off=$(printf '%s\n' "${_tracking}" | awk '
                /^System time/ {
                    for (i = 1; i <= NF; i++) if ($i == "seconds") { v = $(i - 1); d = $(i + 1) }
                    if (v != "") printf "%s%s", (d == "slow" ? "-" : ""), v
                    exit
                }')
            [ -n "${_off}" ] && CLOCK_OFFSET=${_off}
        fi
    fi
}

# Empty when the clock may serve attestations, else why not. $1 is the
# largest offset allowed, in seconds. Reads what clock_status set, which the
# caller runs first in its own shell so it can report the source and offset.
clock_problem() {
    _max=$1
    case ${CLOCK_SYNCED} in
        no) printf 'the host clock is not NTP-synchronised (%s)' "${CLOCK_SOURCE}"; return ;;
        unknown) printf 'cannot tell whether the host clock is NTP-synchronised: neither timedatectl nor chronyc answered'; return ;;
        *) ;;
    esac
    if [ -n "${CLOCK_OFFSET}" ] && ! abs_below "${CLOCK_OFFSET}" "${_max}"; then
        printf 'the host clock is %s s off NTP time (%s), the limit is %s s' "${CLOCK_OFFSET}" "${CLOCK_SOURCE}" "${_max}"
    fi
}
