import { Ed25519PublicKey, AccountAddress } from "@aptos-labs/ts-sdk"
import { fromBech32 } from "@cosmjs/encoding"
import { sha256 } from "@noble/hashes/sha2.js"
import { ripemd160 } from "@noble/hashes/legacy.js"
import { Address, Cell, beginCell, contractAddress } from "@ton/core"
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

// Wallet contract code as deployed on chain; the address is the hash of the
// code and initial data, so these bytes must never change. Copied from
// @ton/ton (WalletContractV4 and WalletContractV5R1), which is not a direct
// dependency here.
const TON_WALLET_V4R2_CODE = Cell.fromBoc(
    Buffer.from(
        "te6ccgECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVA==",
        "base64",
    ),
)[0]

const TON_WALLET_V5R1_CODE = Cell.fromBoc(
    Buffer.from(
        "b5ee9c7241021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0b4d6c35e",
        "hex",
    ),
)[0]

/** Default wallet v4r2 on workchain 0 (wallet id 698983191). */
function tonWalletV4R2Address(publicKey: Buffer): Address {
    const data = beginCell()
        .storeUint(0, 32)
        .storeUint(698983191, 32)
        .storeBuffer(publicKey)
        .storeBit(0)
        .endCell()
    return contractAddress(0, { code: TON_WALLET_V4R2_CODE, data })
}

/**
 * Default wallet v5r1 on workchain 0: client context, version v5r1,
 * subwallet 0, mixed with the network id so a mainnet and a testnet wallet of
 * the same key have different addresses.
 */
function tonWalletV5R1Address(
    publicKey: Buffer,
    networkGlobalId: number,
): Address {
    const context = beginCell()
        .storeUint(1, 1)
        .storeInt(0, 8)
        .storeUint(0, 8)
        .storeUint(0, 15)
        .endCell()
        .beginParse()
        .loadInt(32)
    const data = beginCell()
        .storeUint(1, 1)
        .storeUint(0, 32)
        .storeInt(BigInt(networkGlobalId) ^ BigInt(context), 32)
        .storeBuffer(publicKey, 32)
        .storeBit(0)
        .endCell()
    return contractAddress(0, { code: TON_WALLET_V5R1_CODE, data })
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
                    tonWalletV5R1Address(key, networkGlobalId),
                    tonWalletV4R2Address(key),
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
