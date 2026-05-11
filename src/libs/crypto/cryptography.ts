/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { promises as fs } from "fs"
import forge from "node-forge"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

import { forgeToHex } from "./forgeUtils"

/**
 * Ed25519 key pair with Buffer-typed keys.
 * Unlike forge.pki.KeyPair which unions RSA and ed25519 types,
 * this reflects the actual runtime type produced by our load/new methods.
 */
export interface Ed25519KeyPair {
    publicKey: Buffer
    privateKey: Buffer
}

export default class Cryptography {
    static new(): Ed25519KeyPair {
        const seed = forge.random.getBytesSync(32)
        const keys = forge.pki.ed25519.generateKeyPair({ seed })
        log.debug("Generated new ed25519 keypair")
        return {
            publicKey: Buffer.from(keys.publicKey),
            privateKey: Buffer.from(keys.privateKey),
        }
    }

    // INFO Method to generate a new key pair from a seed
    static newFromSeed(stringSeed: string): Ed25519KeyPair {
        const keys = forge.pki.ed25519.generateKeyPair({ seed: stringSeed })
        return {
            publicKey: Buffer.from(keys.publicKey),
            privateKey: Buffer.from(keys.privateKey),
        }
    }

    // TODO Eliminate the old legacy compatibility
    static async save(keypair: Ed25519KeyPair, path: string, mode = "hex") {
        log.debug(keypair.privateKey)
        if (mode === "hex") {
            const hexPrivKey = Cryptography.saveToHex(keypair.privateKey)
            await fs.writeFile(path, hexPrivKey)
        } else {
            await fs.writeFile(path, JSON.stringify(keypair.privateKey))
        }
    }

    static saveToHex(forgeBuffer: Buffer): string {
        const stringBuffer = forgeBuffer.toString("hex")
        return "0x" + stringBuffer
    }

    static async load(path: string): Promise<Ed25519KeyPair> {
        let keypair: Ed25519KeyPair = {
            privateKey: null,
            publicKey: null,
        }

        const contentOfFile = await fs.readFile(path, "utf8")
        if (contentOfFile.includes("{")) {
            keypair = Cryptography.loadFromBufferString(contentOfFile)
        } else {
            keypair = Cryptography.loadFromHex(contentOfFile)
        }
        return keypair
    }

    static loadFromHex(content: string): Ed25519KeyPair {
        const keypair = { publicKey: null, privateKey: null }
        content = content.slice(2)
        const ED25519_KEY_SIZE = 64
        const keyBytes = new Uint8Array(ED25519_KEY_SIZE)
        for (let i = 0; i < content.length; i += 2) {
            const hexValue = content.substring(i, i + 2)
            keyBytes[i / 2] = parseInt(hexValue, 16)
        }
        keypair.privateKey = Buffer.from(keyBytes)
        keypair.publicKey = Buffer.from(forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        }))
        return keypair
    }

    static loadFromBufferString(content: string): Ed25519KeyPair {
        const keypair = { publicKey: null, privateKey: null }
        keypair.privateKey = Buffer.from(JSON.parse(content))
        keypair.publicKey = Buffer.from(forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        }))
        return keypair
    }

    static sign(
        message: string,
        privateKey: forge.pki.ed25519.BinaryBuffer | string,
    ) {
        if (typeof privateKey === "string") {
            privateKey = forge.util.binary.hex.decode(privateKey)
        }

        return forge.pki.ed25519.sign({
            message,
            encoding: "utf8",
            privateKey,
        })
    }

    static verify(
        signed: string,
        signature: string | forge.pki.ed25519.BinaryBuffer,
        publicKey: string | forge.pki.ed25519.BinaryBuffer,
    ) {
        if (typeof signature === "string") {
            signature = forge.util.binary.hex.decode(signature)
        }

        if (typeof publicKey === "string") {
            publicKey = forge.util.binary.hex.decode(publicKey)
        }

        // Sanitize buffers for forge compatibility
        const ED25519_SIGNATURE_SIZE = 64
        if (signature.length === ED25519_SIGNATURE_SIZE) {
            signature = Buffer.from(signature as Uint8Array)
        }

        if (publicKey.length === ED25519_SIGNATURE_SIZE) {
            publicKey = Buffer.from(publicKey as Uint8Array)
        }

        log.debug(`[Cryptography] Verifying signature for: (${typeof signed}) ${signed}`)
        return forge.pki.ed25519.verify({
            message: signed,
            encoding: "utf8",
            signature,
            publicKey,
        })
    }

    // ANCHOR Encryption part
    static rsa = {
        // INFO Generating a new RSA keypair from our ecdsa private key
        derive: (): forge.pki.rsa.KeyPair => {
            const md = forge.md.sha256.create()
            md.update(
                JSON.stringify(getSharedState.identity.ed25519.privateKey),
            )
            const seed = md.digest().toHex()
            const pnrg = forge.random.createInstance()
            pnrg.seedFileSync = () => seed
            const RSA_KEY_BITS = 4096
            const keys = forge.pki.rsa.generateKeyPair({
                bits: RSA_KEY_BITS,
                prng: pnrg,
            })
            return keys
        },

        // INFO Encryption method using the public key
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forge RSA types are incomplete
        encrypt: (message: string, publicKey: any): [boolean, string] => {
            // NOTE Supporting "fake buffers" from web browsers
            if (publicKey?.type === "Buffer") {
                publicKey = Buffer.from(publicKey)
            }
            const based = forge.util.encode64(message)
            const encrypted = publicKey.encrypt(based)
            return [true, encrypted]
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forge RSA types are incomplete
        decrypt: (message: string, privateKey: any = null): [boolean, string] => {
            // NOTE Supporting "fake buffers" from web browsers
            try {
                if (privateKey?.type === "Buffer") {
                    privateKey = Buffer.from(privateKey)
                }
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e)
                log.debug(
                    "CRYPTO",
                    `[DECRYPTION] Failed to normalize privateKey buffer: ${errorMsg}`,
                )
            }
            // Converting back the message and decrypting it
            // NOTE If no private key is provided, we try to use our one
            if (!privateKey) {
                log.warning(
                    "CRYPTO",
                    "[DECRYPTION] No private key provided, using our one...",
                )
                privateKey = getSharedState.identity.rsa.privateKey
                if (!privateKey) {
                    log.error("CRYPTO", "[DECRYPTION] No private key found")
                    return [false, "No private key found"]
                }
            }
            const debased = forge.util.decode64(message)
            const decrypted = privateKey.decrypt(debased)
            return [true, decrypted.toString()]
        },
    }
}
