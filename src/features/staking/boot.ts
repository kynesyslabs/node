import { nftGatingScheduled } from "@/forks/nftValidatorGatingGate"
import log from "src/utilities/logger"
import { loadNftAllowlist } from "./nftAllowlist"
import { probeSolanaEndpoints } from "./solanaRpc"

/**
 * Boot check for NFT gating, run only on a network that schedules
 * `nftValidatorGating`: the allowlist reads and hashes as pinned, and the
 * configured Solana endpoints are probed. No key is required and an
 * endpoint that does not answer is only reported: Solana is read at
 * admission alone, where a node that cannot reach it leaves seat
 * transactions out of its blocks, so starting without it costs that node
 * its say on seats, not the chain's safety. A bad allowlist does refuse the
 * start, since apply judges every seat against it.
 */
export async function ensureNftGatingReady(): Promise<void> {
    if (!nftGatingScheduled()) return
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
        log.warning(
            "[BOOT] no Solana endpoint answers; this node cannot judge validator NFT proofs " +
                "and leaves seat transactions out until one does (set VALIDATOR_SOLANA_RPCS)",
        )
    }
}
