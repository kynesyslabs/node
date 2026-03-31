import { cryptography } from "../crypto"
import fs from "fs"
import { pki } from "node-forge"
import log from "src/utilities/logger"

async function ensureIdentity(): Promise<pki.KeyPair> {
    let ed25519: pki.KeyPair
    if (fs.existsSync(".demos_identity")) {
        // Loading the identity
        // TODO Add load with cryptography
        ed25519 = await cryptography.load(".demos_identity")
        log.info("KEYMAKER", "Loaded ecdsa identity")
    } else {
        ed25519 = cryptography.new()
        // Writing the identity to disk in binary format
        await cryptography.save(ed25519, ".demos_identity")
        log.info("KEYMAKER", "Generated new identity")
    }
    return ed25519
}

async function main() {
    // Check for -f flag
    const forceNew = process.argv.includes("-f")

    if (forceNew && fs.existsSync(".demos_identity")) {
        await fs.promises.unlink(".demos_identity")
        log.info("KEYMAKER", "Existing .demos_identity file deleted.")
    }

    // Loading or generating the identity
    const identity = await ensureIdentity()
    const publicKey = identity.publicKey.toString("hex")
    const privateKey = identity.privateKey.toString("hex")
    log.info("KEYMAKER", "\n\n====\nPublic Key: " + publicKey)
    log.info("KEYMAKER", "Private Key: " + privateKey)
    log.info("KEYMAKER", "====\n\n")
    // Save to file
    await fs.promises.writeFile("public.key", publicKey)
    await fs.promises.writeFile(".demos_identity", "0x" + privateKey)
    // Logging
    log.info(
        "KEYMAKER",
        "Identity saved (or kept) to .demos_identity and public.key",
    )
}

main()
