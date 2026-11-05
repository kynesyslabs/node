/**
 * Create a mnemonic identity compatible with Identity.loadIdentity.
 * Existing identities are kept; neither the mnemonic nor private keys are printed.
 */
import fs from "fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const IDENTITY_FILE = process.env.IDENTITY_FILE || ".demos_identity"

async function main() {
    if (process.argv.includes("-f")) {
        throw new Error(
            "-f is no longer supported: keygen never deletes or overwrites an identity. " +
                "Move the existing identity file yourself to generate a new one.",
        )
    }

    // Keep the legacy crypto entry order: sharedState eagerly initializes Identity.
    await import("../crypto")
    const identityModule = await import("../identity/identity")
    const websdk = await import("@kynesyslabs/demosdk/websdk")
    const { ucrypto, uint8ArrayToHex } = await import(
        "@kynesyslabs/demosdk/encryption"
    )

    if (!fs.existsSync(IDENTITY_FILE)) {
        const mnemonic = new websdk.Demos().newMnemonic()
        // Exclusive creation also protects a file created concurrently or a symlink.
        await fs.promises.writeFile(IDENTITY_FILE, mnemonic, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        })
    }

    const mnemonic = await fs.promises.readFile(IDENTITY_FILE, "utf8")
    const seed = await identityModule.default.getInstance().mnemonicToSeed(mnemonic)
    await ucrypto.generateAllIdentities(seed)
    const { publicKey } = await ucrypto.getIdentity("ed25519")
    // Preserve the bare hex format historically written to public.key.
    const publicKeyHex = uint8ArrayToHex(publicKey as Uint8Array).replace(/^0x/, "")
    // Do not follow public.key links or truncate an inode shared with the identity.
    const output = await fs.promises.open(
        "public.key",
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    )
    try {
        const outputStat = await output.stat()
        const identityStat = await fs.promises.stat(IDENTITY_FILE)
        if (
            outputStat.nlink !== 1 ||
            (outputStat.dev === identityStat.dev &&
                outputStat.ino === identityStat.ino)
        ) {
            throw new Error(
                "refusing to write public.key: it is linked to an identity or another file",
            )
        }
        await output.truncate(0)
        await output.writeFile(publicKeyHex)
    } finally {
        await output.close()
    }
    console.log(`Public Key (ed25519): ${publicKeyHex}`)
}

if (process.versions.bun) {
    main().catch(err => {
        console.error(`keygen: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
    })
} else {
    // The package script uses tsx, whose pinned parser cannot read import attributes
    // in Identity's dependency graph. Bun is already required by `bun run keygen`.
    // bun run prepends node_modules/.bin to PATH; use the invoking Bun binary.
    const bunExecutable = process.env.npm_config_user_agent?.startsWith("bun/")
        ? process.env.npm_execpath || "bun"
        : "bun"
    const result = spawnSync(
        bunExecutable,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit" },
    )
    if (result.error) {
        console.error(`keygen: could not start Bun: ${result.error.message}`)
    }
    process.exit(result.status ?? 1)
}
