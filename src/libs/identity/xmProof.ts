import { Ed25519PublicKey, AccountAddress } from "@aptos-labs/ts-sdk"
import { fromBech32 } from "@cosmjs/encoding"
import { sha256 } from "@noble/hashes/sha2.js"
import { ripemd160 } from "@noble/hashes/legacy.js"
import { Address, WalletContractV4, WalletContractV5R1 } from "@ton/ton"
import bs58 from "bs58"
import { deriveAddress as deriveXrplAddress } from "ripple-keypairs"

/**
 * What a cross-chain (xm) identity proof signs once `xmProofBinding` is
 * active: `demos-xm:v1:<chain>:<targetAddress>:<demosSender>:<issuedAt>`.
 *
 * Before it, the signed text is whatever the client chose, so any older
 * signature by the same wallet (a login message, another dapp's challenge) is
 * a valid proof, and nothing says which Demos account it was meant for.
 *
 * `issuedAt` is epoch milliseconds. The address of a case-insensitive chain
 * (evm, aptos) and the sender are lower-cased so the signer and the verifier
 * cannot disagree on casing; every other address is signed as written because
 * its alphabet is case-sensitive.
 */
export const XM_PROOF_DOMAIN = "demos-xm:v1"

/** How old a proof may be when the node judges it. */
export const XM_PROOF_MAX_AGE_MS = 10 * 60 * 1000

/** Clock skew tolerated between the signer and this node. */
export const XM_PROOF_MAX_FUTURE_MS = 60 * 1000

const CASE_INSENSITIVE_CHAINS = new Set(["evm", "aptos"])

/** Chains whose proof carries a public key that must be tied to the address. */
export const KEY_DERIVED_CHAINS = [
    "xrpl",
    "ton",
    "ibc",
    "atom",
    "near",
    "aptos",
] as const

/**
 * Normal form of an address for comparison: only chains whose address format
 * ignores case are folded.
 */
export function canonicalXmAddress(chain: string, address: string): string {
    const trimmed = (address ?? "").trim()
    return CASE_INSENSITIVE_CHAINS.has(chain.toLowerCase())
        ? trimmed.toLowerCase()
        : trimmed
}

export function xmBoundProofMessage(
    chain: string,
    targetAddress: string,
    sender: string,
    issuedAt: number | string,
): string {
    const c = chain.toLowerCase()
    return `${XM_PROOF_DOMAIN}:${c}:${canonicalXmAddress(c, targetAddress)}:${sender.toLowerCase()}:${issuedAt}`
}

export type XmCheck = { ok: true } | { ok: false; message: string }

/**
 * Checks that `signedData` is the canonical message for this chain, address
 * and Demos sender, and that it was issued recently.
 */
export function checkXmSignedData(args: {
    chain: string
    targetAddress: string
    sender: string
    signedData: string
    now?: number
}): XmCheck {
    const { chain, targetAddress, sender, signedData } = args
    const now = args.now ?? Date.now()

    if (typeof signedData !== "string" || signedData.length === 0) {
        return { ok: false, message: "xm proof is missing signedData" }
    }

    const issuedAtText = signedData.slice(signedData.lastIndexOf(":") + 1)
    if (!/^\d{1,15}$/.test(issuedAtText)) {
        return {
            ok: false,
            message: `xm proof must sign ${XM_PROOF_DOMAIN}:<chain>:<address>:<sender>:<issuedAt>`,
        }
    }

    const expected = xmBoundProofMessage(
        chain,
        targetAddress,
        sender,
        issuedAtText,
    )
    if (signedData !== expected) {
        return {
            ok: false,
            message: "xm proof does not name this chain, address and sender",
        }
    }

    const issuedAt = Number(issuedAtText)
    if (now - issuedAt > XM_PROOF_MAX_AGE_MS) {
        return { ok: false, message: "xm proof is too old, sign a new one" }
    }
    if (issuedAt - now > XM_PROOF_MAX_FUTURE_MS) {
        return { ok: false, message: "xm proof is issued in the future" }
    }

    return { ok: true }
}

/**
 * Whether `displayAddress` may accompany `targetAddress`: absent, or the same
 * address. The identity is stored under `displayAddress` when present, so any
 * other value would label the proven wallet with an address nobody signed for.
 */
export function checkXmDisplayAddress(
    chain: string,
    targetAddress: string,
    displayAddress: string | undefined | null,
): XmCheck {
    if (displayAddress === undefined || displayAddress === null) {
        return { ok: true }
    }
    if (typeof displayAddress !== "string") {
        return { ok: false, message: "displayAddress must be a string" }
    }
    if (
        canonicalXmAddress(chain, displayAddress) !==
        canonicalXmAddress(chain, targetAddress)
    ) {
        return {
            ok: false,
            message: "displayAddress does not match the signed target address",
        }
    }
    return { ok: true }
}

const HEX_32 = /^(0x)?[0-9a-fA-F]{64}$/

function stripHexPrefix(value: string): string {
    return value.startsWith("0x") || value.startsWith("0X")
        ? value.slice(2)
        : value
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i])
}

function nearKeyBytes(publicKey: string): Uint8Array | null {
    const body = publicKey.startsWith("ed25519:")
        ? publicKey.slice("ed25519:".length)
        : publicKey
    if (publicKey.includes(":") && !publicKey.startsWith("ed25519:")) {
        return null
    }
    const bytes = bs58.decode(body)
    return bytes.length === 32 ? bytes : null
}

function toHexLower(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Ties the public key the signature was verified against to the address being
 * linked, for the chains whose verifier checks the signature against a
 * client-supplied key. Without it the signer is only "some key", not the
 * owner of `targetAddress`.
 *
 * Each case derives the address from the key offline. Where an address cannot
 * be derived from a key without asking the network, the add is refused rather
 * than left unbound: NEAR named accounts (the key is an access key on the
 * account, not its name).
 */
export function checkAddressDerivedFromKey(args: {
    chain: string
    subchain?: string
    publicKey: string | undefined
    targetAddress: string
}): XmCheck {
    const { chain, subchain, publicKey, targetAddress } = args
    const mismatch: XmCheck = {
        ok: false,
        message: `${chain} public key does not belong to the target address`,
    }

    if (!publicKey || typeof publicKey !== "string") {
        return { ok: false, message: `${chain} proof is missing publicKey` }
    }

    try {
        switch (chain) {
            case "xrpl":
                return deriveXrplAddress(publicKey) === targetAddress
                    ? { ok: true }
                    : mismatch

            case "ton": {
                const hex = stripHexPrefix(publicKey)
                if (!HEX_32.test(hex)) return mismatch
                const key = Buffer.from(hex, "hex")
                const target = Address.parse(targetAddress)
                // The key does not say which wallet contract holds the funds,
                // so every contract the SDK and common wallets deploy is tried.
                const networkGlobalId = subchain === "testnet" ? -3 : -239
                const candidates = [
                    WalletContractV5R1.create({
                        publicKey: key,
                        workchain: 0,
                        walletId: { networkGlobalId },
                    }).address,
                    WalletContractV4.create({ publicKey: key, workchain: 0 })
                        .address,
                ]
                return candidates.some(a => a.equals(target))
                    ? { ok: true }
                    : mismatch
            }

            case "ibc":
            case "atom": {
                const key = Buffer.from(publicKey, "base64")
                if (key.length !== 33) return mismatch
                const { data } = fromBech32(targetAddress)
                return bytesEqual(ripemd160(sha256(key)), data)
                    ? { ok: true }
                    : mismatch
            }

            case "near": {
                const key = nearKeyBytes(publicKey)
                if (!key) return mismatch
                if (targetAddress === `ed25519:${bs58.encode(key)}`) {
                    return { ok: true }
                }
                if (/^[0-9a-f]{64}$/.test(targetAddress)) {
                    return toHexLower(key) === targetAddress
                        ? { ok: true }
                        : mismatch
                }
                return {
                    ok: false,
                    message:
                        "near named accounts cannot be tied to a key without querying the network; link the implicit account (hex of the public key)",
                }
            }

            case "aptos": {
                const hex = stripHexPrefix(publicKey)
                if (!HEX_32.test(hex)) return mismatch
                const derived = new Ed25519PublicKey(hex)
                    .authKey()
                    .derivedAddress()
                const target = AccountAddress.from(targetAddress, {
                    maxMissingChars: 63,
                })
                return derived.equals(target) ? { ok: true } : mismatch
            }

            default:
                return {
                    ok: false,
                    message: `${chain} identities cannot be bound to a key here`,
                }
        }
    } catch {
        return mismatch
    }
}
