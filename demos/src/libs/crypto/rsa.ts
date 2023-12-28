/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"

export default class RSA {
    // INFO Generates a new RSA keypair from a given ecdsa private key
    static async new(ecdsaPrivateKey: string) {
        const md = forge.md.sha256.create()
        md.update(ecdsaPrivateKey)
        const seed = md.digest().toHex()
        const prng = forge.random.createInstance()
        prng.seedFileSync = () => seed
        const keypair = forge.pki.rsa.generateKeyPair({
            bits: 4096,
            prng,
        })
        return keypair
    }

    // INFO signing method
    static async sign(message: string, privateKey: forge.pki.rsa.PrivateKey) {
        const md = forge.md.sha256.create()
        md.update(message)
        const signature = privateKey.sign(md)
        return signature
    }

    // INFO verifying method
    static async verify(
        message: string,
        signature: string,
        publicKey: forge.pki.rsa.PublicKey,
    ) {
        const md = forge.md.sha256.create()
        md.update(message)
        const verified = publicKey.verify(md.digest().bytes(), signature)
        return verified
    }

    // INFO encrypting method
    static async encrypt(message: string, publicKey: forge.pki.rsa.PublicKey) {
        const encrypted = publicKey.encrypt(message)
        return encrypted
    }

    // INFO decrypting method
    static async decrypt(
        message: string,
        privateKey: forge.pki.rsa.PrivateKey,
    ) {
        const decrypted = privateKey.decrypt(message)
        return decrypted
    }
}
