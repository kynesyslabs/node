import Enigma from "./enigma"

async function testing() {
    let enigma = new Enigma()
    await enigma.init()
    console.log("[Enigma] Initialized")
    const message = "Hello World"
    console.log("[BOB] [Message]\n" + message)
    const additionalData = "Additional Data"
    console.log("\n[BOB] [Additional Data]\n", additionalData + "\n")
    console.log("[BOB] [Signature] Signing...")
    const signature = await enigma.sign(message, additionalData)
    //console.log(signature)
    console.log("[BOB] [Signature] Signed")
    console.log("\n[Encryption] Pretending to be someon else...\n")
    console.log("[ALICE] [Signature] Verifying...")
    const verified = await enigma.verify(
        signature,
        message,
        enigma.signingKeyPair.publicKey,
        additionalData,
    )
    console.log("[ALICE] [Verified] " + verified)

    /* SECTION Encryption / Decryption with McEliece */
    console.log("[BOB] [Encryption] Generating shared secret...")
    // NOTE We are using ourselves but that should be a peer's public key
    let peerKey = enigma.mcelieceKeypair.publicKey
    console.log("[BOB] [Encryption] Using ALICE public key: ")
    //console.log(peerKey)
    let sharedSecret = await enigma.generateSecrets(peerKey)
    console.log("[BOB] Shared secret generated")
    console.log(sharedSecret.secret)
    //console.log(sharedSecret.shared)
    console.log("\n[Encryption] Pretending to be someon else...\n")
    console.log(
        "[ALICE] [Encryption] We received a shared secret from the peer!",
    )
    //console.log(sharedSecret.shared)
    console.log(
        "[ALICE] [Encryption] Deriving the real secret using our private key...",
    )
    let secret = await enigma.deriveSharedSecret(sharedSecret.shared)
    console.log(secret)
    // Now we should use the secret to set up a symmetric encryption communication channel
    let password = "MySecret"
    console.log("[BOB] Hashing and sending the password hash...")
    let hash = await enigma.hash(password)
    console.log(hash)
    console.log("\n[Hashing] Pretending to be someon else...\n")
    console.log("[ALICE] [Hashing] We received a hash from the peer!")
    let verifiedHash = await enigma.checkHash(password, hash)
    console.log(verifiedHash)
}

testing()
