import { Peer, PeerManager } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import { getStakedSet } from "src/libs/consensus/stakedSet"
import log from "src/utilities/logger"

let vetoActive = false

export const DISCREDIT_MS = 60_000

// Peers whose advertised height sync could not download. Until the entry
// expires or the peer serves us blocks, its gossip claim does not count
// as the network being ahead at any height; its corroborated sync state
// still does. The whole claim is ignored, not just the failed height, so
// re-advertising one block higher buys nothing.
const discredited = new Map<string, number>()

/**
 * Records that `peer` failed to serve blocks it advertised. A peer that
 * is really ahead serves them on a later attempt and is credited again.
 */
export function discreditAdvertisedHeight(peer: Peer): void {
    const height = peer.gossip?.height ?? 0
    if (height <= getSharedState.lastBlockNumber) return
    discredited.set(peer.identity.toLowerCase(), Date.now() + DISCREDIT_MS)
    log.warning(
        `[networkAheadVeto] ${peer.identity} advertised height ${height} but could not serve it; ignoring its claims for ${DISCREDIT_MS / 1000}s`,
    )
}

/** `peer` served blocks, so its advertised height counts again. */
export function creditAdvertisedHeight(peer: Peer): void {
    discredited.delete(peer.identity.toLowerCase())
}

export function clearDiscreditedHeights(): void {
    discredited.clear()
}

/** The height this peer is believed to be at, discredited claims excluded. */
export function credibleHeight(peer: Peer, now = Date.now()): number {
    const corroborated = peer.sync.block ?? 0
    const key = peer.identity.toLowerCase()
    const until = discredited.get(key)
    if (until !== undefined) {
        if (until > now) return corroborated
        discredited.delete(key)
    }
    return Math.max(corroborated, peer.gossip?.height ?? 0)
}

export async function getAheadValidatorPeers(): Promise<Peer[]> {
    const ourBlock = getSharedState.lastBlockNumber
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    // peer.sync is corroborated and can never exceed our own head; the
    // signed self-attested head from gossip heights records is what lets
    // a lagging node see the network is ahead at all.
    const now = Date.now()
    const aheadPeers = onlinePeers.filter(
        peer => credibleHeight(peer, now) > ourBlock,
    )

    if (aheadPeers.length === 0) {
        return []
    }

    const validatorAddresses = await getStakedSet()
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

    return aheadPeers.filter(peer =>
        validatorAddresses.has(peer.identity.toLowerCase()),
    )
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
                    advertised: peer.gossip?.height ?? null,
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
