import { Ed25519PublicKey } from "@aptos-labs/ts-sdk"
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino"
import { Secp256k1 } from "@cosmjs/crypto"
import { toBase64, toBech32 } from "@cosmjs/encoding"
import { sha256 } from "@noble/hashes/sha2.js"
import { keyPairFromSeed, sign as tonSign } from "@ton/crypto"
import { WalletContractV5R1 } from "@ton/ton"
import bs58 from "bs58"
import { Wallet } from "ethers"
import {
    deriveAddress,
    deriveKeypair,
    generateSeed,
    sign as xrplSign,
} from "ripple-keypairs"
import nacl from "tweetnacl"

/**
 * A wallet on one chain with the address, public key and message signer the
 * node expects, built from the chain's own libraries so the tests do not
 * lean on the code that derives addresses.
 */
export type ChainFixture = {
    chain: string
    subchain: string
    isEVM: boolean
    targetAddress: string
    publicKey?: string
    sign: (message: string) => Promise<string>
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

function seed32(tag: number): Uint8Array {
    return new Uint8Array(32).fill(tag)
}

export function evmFixture(): ChainFixture {
    const wallet = new Wallet("0x" + "11".repeat(32))
    return {
        chain: "evm",
        subchain: "mainnet",
        isEVM: true,
        targetAddress: wallet.address,
        sign: m => wallet.signMessage(m),
    }
}

export function xrplFixture(
    algorithm: "ed25519" | "ecdsa-secp256k1" = "ed25519",
): ChainFixture {
    const keys = deriveKeypair(generateSeed({ algorithm }))
    return {
        chain: "xrpl",
        subchain: "mainnet",
        isEVM: false,
        targetAddress: deriveAddress(keys.publicKey),
        publicKey: keys.publicKey,
        sign: async m =>
            xrplSign(Buffer.from(m, "utf8").toString("hex").toUpperCase(), keys.privateKey),
    }
}

export function tonFixture(subchain = "mainnet", tag = 5): ChainFixture {
    const pair = keyPairFromSeed(Buffer.from(seed32(tag)))
    const wallet = WalletContractV5R1.create({
        publicKey: pair.publicKey,
        workchain: 0,
        walletId: { networkGlobalId: subchain === "testnet" ? -3 : -239 },
    })
    return {
        chain: "ton",
        subchain,
        isEVM: false,
        targetAddress: wallet.address.toString({ urlSafe: true, bounceable: false }),
        publicKey: pair.publicKey.toString("hex"),
        sign: async m =>
            tonSign(Buffer.from(m, "utf8"), pair.secretKey).toString("base64"),
    }
}

export async function ibcFixture(
    chain: "ibc" | "atom" = "atom",
    prefix = "cosmos",
    tag = 9,
): Promise<ChainFixture> {
    const priv = seed32(tag)
    const pair = await Secp256k1.makeKeypair(priv)
    const compressed = Secp256k1.compressPubkey(pair.pubkey)
    return {
        chain,
        subchain: "mainnet",
        isEVM: false,
        targetAddress: toBech32(prefix, rawSecp256k1PubkeyToRawAddress(compressed)),
        publicKey: toBase64(compressed),
        sign: async m => {
            const sig = await Secp256k1.createSignature(sha256(Buffer.from(m, "utf8")), priv)
            return toBase64(sig.toFixedLength())
        },
    }
}

export function nearFixture(tag = 3): ChainFixture {
    const pair = nacl.sign.keyPair.fromSeed(seed32(tag))
    return {
        chain: "near",
        subchain: "mainnet",
        isEVM: false,
        targetAddress: hex(pair.publicKey),
        publicKey: `ed25519:${bs58.encode(pair.publicKey)}`,
        sign: async m =>
            bs58.encode(nacl.sign.detached(Buffer.from(m, "utf8"), pair.secretKey)),
    }
}

export function aptosFixture(tag = 4): ChainFixture {
    const pair = nacl.sign.keyPair.fromSeed(seed32(tag))
    const publicKey = "0x" + hex(pair.publicKey)
    return {
        chain: "aptos",
        subchain: "mainnet",
        isEVM: false,
        targetAddress: new Ed25519PublicKey(publicKey)
            .authKey()
            .derivedAddress()
            .toString(),
        publicKey,
        sign: async m =>
            hex(nacl.sign.detached(Buffer.from(m, "utf8"), pair.secretKey)),
    }
}
