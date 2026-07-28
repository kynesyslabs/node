import { Peer, PeerManager } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"
import log from "src/utilities/logger"
import type { Validators } from "src/model/entities/Validators"

let cachedBlock: number | null = null
let cachedAddresses: Set<string> | null = null
let vetoActive = false

async function getValidatorAddresses(lastBlock: number): Promise<Set<string>> {
    if (cachedBlock === lastBlock && cachedAddresses !== null) {
        return cachedAddresses
    }

    const validators = (await GCR.getGCRValidatorsAtBlock(
        lastBlock,
    )) as Validators[]
    cachedAddresses = new Set(
        validators.map(v => v.address).filter((a): a is string => a !== null),
    )
    cachedBlock = lastBlock
    return cachedAddresses
}

export async function getAheadValidatorPeers(): Promise<Peer[]> {
    const ourBlock = getSharedState.lastBlockNumber
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    const aheadPeers = onlinePeers.filter(peer => peer.sync.block > ourBlock)

    if (aheadPeers.length === 0) {
        return []
    }

    const validatorAddresses = await getValidatorAddresses(ourBlock)
    if (validatorAddresses.size === 0) {
        // Same bootstrap edge case guarded in peerlistMerge/getShard: with no
        // validator set to filter against, ANY peer claiming a higher block
        // can veto forging or abort a round before voting. Surface it rather
        // than falling back silently.
        if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
            throw new Error(
                "[networkAheadVeto] no active validators AND DEMOS_REQUIRE_VALIDATORS=true; refusing to operate",
            )
        }
        log.warning(
            "[networkAheadVeto] SECURITY: no active validators in DB; vetoing on unfiltered " +
                "ahead-peers. This is only acceptable on development networks.",
        )
        return aheadPeers
    }

    return aheadPeers.filter(peer => validatorAddresses.has(peer.identity))
}

export async function isNetworkAhead(context: string): Promise<boolean> {
    const aheadPeers = await getAheadValidatorPeers()

    if (aheadPeers.length === 0) {
        if (vetoActive) {
            vetoActive = false
            log.info(
                `[networkAheadVeto] Veto lifted at block ${getSharedState.lastBlockNumber}`,
            )
        }
        return false
    }

    vetoActive = true
    log.warning(
        `[networkAheadVeto] (${context}) Deferring consensus at block ${getSharedState.lastBlockNumber}: ` +
            `${aheadPeers.length} validator peer(s) ahead: ` +
            JSON.stringify(
                aheadPeers.map(peer => ({
                    peer: peer.connection.string,
                    block: peer.sync.block,
                })),
            ),
    )

    try {
        const { getMetricsService } = await import("@/features/metrics")
        getMetricsService().incrementCounter(
            "consensus_network_ahead_veto_total",
            { context },
            1,
        )
    } catch (error) {
        log.debug("[networkAheadVeto] Metrics unavailable: " + error)
    }

    return true
}
