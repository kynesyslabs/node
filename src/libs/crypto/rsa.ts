/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"

const RSA_KEY_BITS = 4096

export default class RSA {
    static new(ecdsaPrivateKey: string) {
        const md = forge.md.sha256.create()
        md.update(ecdsaPrivateKey)
        const seed = md.digest().toHex()
        const prng = forge.random.createInstance()
        prng.seedFileSync = () => seed
        return forge.pki.rsa.generateKeyPair({
            bits: RSA_KEY_BITS,
            prng,
        })
    }

    static sign(message: string, privateKey: forge.pki.rsa.PrivateKey) {
        const md = forge.md.sha256.create()
        md.update(message)
        return privateKey.sign(md)
    }

    static verify(
        message: string,
        signature: string,
        publicKey: forge.pki.rsa.PublicKey,
    ) {
        const md = forge.md.sha256.create()
        md.update(message)
        return publicKey.verify(md.digest().bytes(), signature)
    }

    static encrypt(message: string, publicKey: forge.pki.rsa.PublicKey) {
        return publicKey.encrypt(message)
    }

    static decrypt(
        message: string,
        privateKey: forge.pki.rsa.PrivateKey,
    ) {
        return privateKey.decrypt(message)
    }
}
