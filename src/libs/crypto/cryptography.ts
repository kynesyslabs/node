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

export default class Cryptography {
    static new() {
        const seed = forge.random.getBytesSync(32)
        const keys = forge.pki.ed25519.generateKeyPair({ seed })
        log.debug("Generated new ed25519 keypair")
        return keys
    }

    // INFO Method to generate a new key pair from a seed
    static newFromSeed(stringSeed: string) {
        return forge.pki.ed25519.generateKeyPair({ seed: stringSeed })
    }

    // TODO Eliminate the old legacy compatibility
    static async save(keypair: forge.pki.KeyPair, path: string, mode = "hex") {
        log.debug(keypair.privateKey)
        if (mode === "hex") {
            const hexPrivKey = Cryptography.saveToHex(keypair.privateKey)
            await fs.writeFile(path, hexPrivKey)
        } else {
            await fs.writeFile(path, JSON.stringify(keypair.privateKey))
        }
    }

    static saveToHex(forgeBuffer: forge.pki.PrivateKey): string {
        log.debug("[forge to string encoded]")
        const stringBuffer = forgeBuffer.toString("hex")
        log.debug("DECODED INTO:")
        log.debug("0x" + stringBuffer)
        return "0x" + stringBuffer
    }

    static async load(path) {
        let keypair: forge.pki.KeyPair = {
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

    static loadFromHex(content: string): forge.pki.KeyPair {
        const keypair = { publicKey: null, privateKey: null }
        content = content.slice(2)
        const finalArray = new Uint8Array(64)
        log.debug("[string to forge encoded]")
        log.debug(content)
        for (let i = 0; i < content.length; i += 2) {
            const hexValue = content.substr(i, 2)
            const decimalValue = parseInt(hexValue, 16)
            finalArray[i / 2] = decimalValue
        }
        log.debug("ENCODED INTO:")
        // Condensing
        log.debug("That means:")
        keypair.privateKey = Buffer.from(finalArray)
        log.debug(keypair.privateKey)
        log.debug("And the public key is:")
        keypair.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        log.debug(keypair.publicKey)
        return keypair
    }

    static loadFromBufferString(content: string): forge.pki.KeyPair {
        const keypair = { publicKey: null, privateKey: null }
        keypair.privateKey = Buffer.from(JSON.parse(content))
        keypair.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        return keypair
    }

    static sign(
        message: string,
        privateKey: forge.pki.ed25519.BinaryBuffer | any,
    ) {
        // REVIEW Test HexToForge support
        if (privateKey.type == "string") {
            log.debug("[HexToForge] Deriving a buffer from privateKey...")
            // privateKey = HexToForge(privateKey)
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
        // REVIEW Test HexToForge support
        if (typeof signature == "string") {
            log.debug(
                "[HexToForge] Deriving a buffer from signature: " + signature,
            )
            // signature = HexToForge(signature)
            signature = forge.util.binary.hex.decode(signature)
        }

        if (typeof publicKey == "string") {
            log.debug("[HexToForge] Deriving a buffer from publicKey...")
            // publicKey = HexToForge(publicKey)
            publicKey = forge.util.binary.hex.decode(publicKey)
        }

        // Also, we have to sanitize buffers so that they are forge compatible
        if (signature.length == 64) {
            signature = Buffer.from(signature as Uint8Array) // REVIEW Does not work in bun
        }

        if (publicKey.length == 64) {
            publicKey = Buffer.from(publicKey as Uint8Array) // REVIEW Does not work in bun
        }

        log.debug(
            "[Cryptography] Verifying the signature of: (" +
                typeof signed +
                ") " +
                signed,
        )
        log.debug(
            "[Cryptography] Using the signature: (" +
                typeof signature +
                ") " +
                forgeToHex(signature),
        )
        log.debug(
            "[Cryptography] And the public key: (" +
                typeof publicKey +
                ") " +
                forgeToHex(publicKey),
        )
        return forge.pki.ed25519.verify({
            message: signed,
            encoding: "utf8",
            signature: signature,
            publicKey: publicKey,
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
            const keys = forge.pki.rsa.generateKeyPair({
                bits: 4096,
                prng: pnrg,
            })
            return keys
        },

        // INFO Encryption method using the public key
        encrypt: (
            message: string,
            publicKey: any | forge.pki.rsa.PublicKey,
        ): [boolean, any] => {
            // NOTE Supporting "fake buffers" from web browsers
            if (publicKey.type == "Buffer") {
                publicKey = Buffer.from(publicKey)
            }
            // Converting the message and decrypting it
            const based = forge.util.encode64(message)
            const encrypted = publicKey.encrypt(based)
            return [true, encrypted]
        },

        // INFO Decryption method using the private key
        decrypt: (
            message: string,
            privateKey: any | forge.pki.rsa.PrivateKey = null,
        ): [boolean, any] => {
            // NOTE Supporting "fake buffers" from web browsers
            try {
                if (privateKey.type == "Buffer") {
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
