import { Config } from "src/config"
import log from "src/utilities/logger"
import { loadNftAllowlist } from "./nftAllowlist"
import { probeSolanaEndpoints } from "./solanaRpc"

/**
 * Boot check for NFT gating: a Helius key is set, the allowlist reads and
 * hashes as configured, and at least one Solana endpoint answers. A node
 * that cannot verify proofs refuses to start rather than vote blind.
 */
export async function ensureNftGatingReady(): Promise<void> {
    if (Config.getInstance().identity.heliusApiKey.trim() === "") {
        throw new Error(
            "[BOOT] HELIUS_API_KEY is not set; validator NFT gating needs a Helius key for proof checks and the staking page",
        )
    }
    loadNftAllowlist()
    const probes = await probeSolanaEndpoints()
    for (const probe of probes) {
        if (probe.ok) {
            log.info(`[BOOT] Solana endpoint ${probe.url} answers`)
        } else {
            log.warning(`[BOOT] Solana endpoint ${probe.url} does not answer`)
        }
    }
    if (!probes.some(probe => probe.ok)) {
        throw new Error(
            "[BOOT] no Solana endpoint answers; set SOLANA_RPC or HELIUS_API_KEY",
        )
    }
}
