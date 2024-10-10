import * as forge from "node-forge"

export class EnhancedCrypto {
    // This generates RSA keys. While a larger key size (8192 bits) provides strong
    // classical security, RSA is not quantum-resistant regardless of key size.
    // For true quantum resistance, we would need to use post-quantum algorithms.
    static generateKeys(): { publicKey: string; privateKey: string } {
        const rsa = forge.pki.rsa.generateKeyPair({ bits: 8192, e: 0x10001 })

        return {
            publicKey: forge.pki.publicKeyToPem(rsa.publicKey),
            privateKey: forge.pki.privateKeyToPem(rsa.privateKey),
        }
    }

    // Signing uses SHA-512 for hashing, which is currently considered secure against
    // known quantum attacks. However, the RSA signature itself is not quantum-resistant.
    static sign(message: string, privateKey: string): string {
        const md = forge.md.sha512.create()
        md.update(message, "utf8")

        const rsaPrivateKey = forge.pki.privateKeyFromPem(privateKey)
        const signature = rsaPrivateKey.sign(md)

        return forge.util.encode64(signature)
    }

    // Verification process. Like signing, it uses SHA-512 which is quantum-secure,
    // but the RSA verification is not quantum-resistant.
    static verify(
        message: string,
        signature: string,
        publicKey: string,
    ): boolean {
        const md = forge.md.sha512.create()
        md.update(message, "utf8")

        const rsaPublicKey = forge.pki.publicKeyFromPem(publicKey)
        const decodedSignature = forge.util.decode64(signature)

        return rsaPublicKey.verify(md.digest().getBytes(), decodedSignature)
    }

    // Encryption uses a hybrid approach:
    // 1. AES-GCM for symmetric encryption (considered quantum-resistant)
    // 2. RSA-OAEP for key encapsulation (not quantum-resistant)
    // This provides strong classical security but is vulnerable to quantum attacks on the RSA component.
    static encrypt(message: string, publicKey: string): string {
        const rsaPublicKey = forge.pki.publicKeyFromPem(publicKey)

        // AES-256 key generation (quantum-resistant)
        const aesKey = forge.random.getBytesSync(32)
        const iv = forge.random.getBytesSync(16)

        // AES-GCM encryption (quantum-resistant)
        const cipher = forge.cipher.createCipher("AES-GCM", aesKey)
        cipher.start({ iv: iv })
        cipher.update(forge.util.createBuffer(message, "utf8"))
        cipher.finish()

        // RSA-OAEP encryption of the AES key (not quantum-resistant)
        const encryptedKey = rsaPublicKey.encrypt(aesKey, "RSA-OAEP")

        // Combine all components
        const result = {
            key: forge.util.encode64(encryptedKey),
            iv: forge.util.encode64(iv),
            ciphertext: forge.util.encode64(cipher.output.getBytes()),
            tag: forge.util.encode64(cipher.mode.tag.getBytes()),
        }

        return JSON.stringify(result)
    }

    // Decryption reverses the encryption process:
    // 1. RSA-OAEP for key decapsulation (not quantum-resistant)
    // 2. AES-GCM for symmetric decryption (considered quantum-resistant)
    // The overall security is limited by the RSA component, which is not quantum-resistant.
    static decrypt(encryptedMessage: string, privateKey: string): string {
        const rsaPrivateKey = forge.pki.privateKeyFromPem(privateKey)
        const encryptedData = JSON.parse(encryptedMessage)

        // RSA-OAEP decryption of the AES key (not quantum-resistant)
        const aesKey = rsaPrivateKey.decrypt(
            forge.util.decode64(encryptedData.key),
            "RSA-OAEP",
        )

        // AES-GCM decryption (quantum-resistant)
        const decipher = forge.cipher.createDecipher("AES-GCM", aesKey)
        decipher.start({
            iv: forge.util.createBuffer(forge.util.decode64(encryptedData.iv)),
            tag: forge.util.createBuffer(
                forge.util.decode64(encryptedData.tag),
            ),
        })
        decipher.update(
            forge.util.createBuffer(
                forge.util.decode64(encryptedData.ciphertext),
            ),
        )
        const pass = decipher.finish()

        if (pass) {
            return decipher.output.toString()
        } else {
            throw new Error("Decryption failed")
        }
    }
}