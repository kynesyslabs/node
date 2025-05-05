import { EnhancedCrypto } from "./enigma_lite"
async function runTests() {
    console.log("Generating keys...")
    const { publicKey, privateKey } = EnhancedCrypto.generateKeys()
    console.log("Keys generated.")

    const message = "Hello, world! This is a secret message."
    console.log(`Original message: ${message}`)

    // Signing
    console.log("Signing message...")
    const signature = EnhancedCrypto.sign(message, privateKey)
    console.log(`Signature: ${signature}`)

    // Verifying
    console.log("Verifying signature...")
    const isValid = EnhancedCrypto.verify(message, signature, publicKey)
    console.log(`Signature valid: ${isValid}`)

    // Encrypting
    console.log("Encrypting message...")
    const encrypted = EnhancedCrypto.encrypt(message, publicKey)
    console.log(`Encrypted message: ${encrypted}`)

    // Decrypting
    console.log("Decrypting message...")
    const decrypted = EnhancedCrypto.decrypt(encrypted, privateKey)
    console.log(`Decrypted message: ${decrypted}`)

    // Verify decryption was successful
    console.log(`Decryption successful: ${message === decrypted}`)
}

runTests()