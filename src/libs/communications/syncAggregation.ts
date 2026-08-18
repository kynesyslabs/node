import type Block from "../blockchain/block"

export const SYNC_AGGREGATE_VERSION = 1 as const
export const MAX_SYNC_AGGREGATE_IDENTITIES = 1000
export const MAX_SYNC_AGGREGATE_IDENTITY_LENGTH = 256

export interface BlockSyncAggregateV1 {
    version: typeof SYNC_AGGREGATE_VERSION
    blockNumber: number
    blockHash: string
    syncedPeerIds: string[]
}

export interface PostBlockTrafficEstimate {
    nodeCount: number
    signerCount: number
    blockPublishers: number
    blockDeliveries: number
    receiverSyncBroadcasts: number
    senderSyncBroadcasts: number
    aggregateBroadcasts: number
    totalRequests: number
}

export interface SyncAggregateBlockView {
    number: number
    hash: string
    validation_data?: {
        signatures?: Record<string, unknown>
    }
    content?: {
        peerlist?: unknown
    }
}

export type SyncAggregateAdmission =
    | {
          ok: true
          acceptedPeerIds: string[]
      }
    | {
          ok: false
          status: 400 | 403
          message: string
      }

interface SyncResponseLike {
    pubkey: string
    result: {
        result: number
        response?: unknown
    }
}

function normalizeIdentity(identity: string): string {
    return identity.toLowerCase()
}

function isBoundedIdentity(identity: string): boolean {
    return (
        identity.length > 0 &&
        identity.length <= MAX_SYNC_AGGREGATE_IDENTITY_LENGTH
    )
}

export function shouldPublishBlock(
    aggregateEnabled: boolean,
    localIdentity: string,
    committeeIdentities: string[],
): boolean {
    if (!aggregateEnabled) return true
    const designatedPublisher = committeeIdentities[0]
    return (
        typeof designatedPublisher === "string" &&
        normalizeIdentity(designatedPublisher) ===
            normalizeIdentity(localIdentity)
    )
}

/**
 * Return the compact `status:block:hash` value carried by syncNewBlock.
 * The outer RPC response contains the handler response under `response`.
 */
export function extractSyncData(response: SyncResponseLike): string | null {
    if (response.result.result !== 200) return null
    const body = response.result.response
    if (!body || typeof body !== "object") return null
    const syncData = (body as { syncData?: unknown }).syncData
    return typeof syncData === "string" ? syncData : null
}

export function syncDataMatchesBlock(
    syncData: string,
    blockNumber: number,
    blockHash: string,
): boolean {
    const [status, rawBlock, claimedHash, ...extra] = syncData.split(":")
    if (extra.length > 0 || !/^\d+$/.test(rawBlock)) return false
    const claimedBlock = Number.parseInt(rawBlock, 10)
    return (
        status === "1" &&
        Number.isInteger(claimedBlock) &&
        claimedBlock === blockNumber &&
        claimedHash === blockHash
    )
}

/**
 * Build a deterministic, bounded acknowledgement aggregate from the block
 * delivery responses. A peer is included only when its returned sync state
 * names the exact block just delivered.
 */
export function buildSyncAggregate(
    block: Pick<Block, "number" | "hash">,
    senderIdentity: string,
    responses: SyncResponseLike[],
): BlockSyncAggregateV1 {
    const identities = new Set<string>()
    if (isBoundedIdentity(senderIdentity)) {
        identities.add(normalizeIdentity(senderIdentity))
    }

    for (const response of responses) {
        if (identities.size >= MAX_SYNC_AGGREGATE_IDENTITIES) break
        const syncData = extractSyncData(response)
        if (
            isBoundedIdentity(response.pubkey) &&
            syncData &&
            syncDataMatchesBlock(syncData, block.number, block.hash)
        ) {
            identities.add(normalizeIdentity(response.pubkey))
        }
    }

    return {
        version: SYNC_AGGREGATE_VERSION,
        blockNumber: block.number,
        blockHash: block.hash,
        syncedPeerIds: [...identities]
            .sort()
            .slice(0, MAX_SYNC_AGGREGATE_IDENTITIES),
    }
}

export function isBlockSyncAggregateV1(
    value: unknown,
): value is BlockSyncAggregateV1 {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    const aggregate = value as Record<string, unknown>
    return (
        aggregate.version === SYNC_AGGREGATE_VERSION &&
        typeof aggregate.blockNumber === "number" &&
        Number.isSafeInteger(aggregate.blockNumber) &&
        aggregate.blockNumber >= 0 &&
        typeof aggregate.blockHash === "string" &&
        aggregate.blockHash.length > 0 &&
        aggregate.blockHash.length <= 256 &&
        Array.isArray(aggregate.syncedPeerIds) &&
        aggregate.syncedPeerIds.length <= MAX_SYNC_AGGREGATE_IDENTITIES &&
        aggregate.syncedPeerIds.every(
            identity =>
                typeof identity === "string" && isBoundedIdentity(identity),
        )
    )
}

/**
 * Validate a relayed acknowledgement set against a block already verified by
 * the receiver. The aggregate cannot add an identity to the peer set, mark an
 * identity online, or describe a block absent from the receiver's chain.
 */
export function admitSyncAggregate(
    value: unknown,
    block: SyncAggregateBlockView | null,
    senderIdentity: string,
    localIdentity: string,
    knownPeerIdentities: string[],
): SyncAggregateAdmission {
    if (!isBlockSyncAggregateV1(value)) {
        return {
            ok: false,
            status: 400,
            message: "Invalid sync aggregate",
        }
    }
    if (
        !block ||
        block.number !== value.blockNumber ||
        block.hash !== value.blockHash
    ) {
        return {
            ok: false,
            status: 400,
            message: "Sync aggregate does not match the local chain",
        }
    }

    const signerIds = new Set(
        Object.keys(block.validation_data?.signatures ?? {}).map(
            normalizeIdentity,
        ),
    )
    if (!signerIds.has(normalizeIdentity(senderIdentity))) {
        return {
            ok: false,
            status: 403,
            message: "Sync aggregate sender did not sign the block",
        }
    }

    const eligibleIds = new Set<string>(signerIds)
    const committedPeerlist = Array.isArray(block.content?.peerlist)
        ? block.content.peerlist
        : []
    for (const entry of committedPeerlist) {
        if (typeof entry === "string") {
            eligibleIds.add(normalizeIdentity(entry))
        } else if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { identity?: unknown }).identity === "string"
        ) {
            eligibleIds.add(
                normalizeIdentity((entry as { identity: string }).identity),
            )
        }
    }

    const local = normalizeIdentity(localIdentity)
    const knownIds = new Set(knownPeerIdentities.map(normalizeIdentity))
    const acceptedPeerIds: string[] = []
    const seen = new Set<string>()
    for (const claimedIdentity of value.syncedPeerIds) {
        const identity = normalizeIdentity(claimedIdentity)
        if (
            seen.has(identity) ||
            identity === local ||
            !eligibleIds.has(identity) ||
            !knownIds.has(identity)
        ) {
            continue
        }
        seen.add(identity)
        acceptedPeerIds.push(identity)
    }

    return { ok: true, acceptedPeerIds }
}

/**
 * Model the post-block request burst. This deliberately excludes periodic
 * anti-entropy because it is not triggered once per block.
 */
export function estimatePostBlockTraffic(
    nodeCount: number,
    signerCount: number,
    aggregateEnabled: boolean,
): PostBlockTrafficEstimate {
    const nodes = Math.max(0, Math.floor(nodeCount))
    const signers = Math.min(nodes, Math.max(0, Math.floor(signerCount)))
    const recipients = nodes - signers

    if (aggregateEnabled) {
        const blockPublishers = signers > 0 ? 1 : 0
        const blockDeliveries = blockPublishers * recipients
        const aggregateBroadcasts =
            blockDeliveries > 0 ? Math.max(0, nodes - 1) : 0
        return {
            nodeCount: nodes,
            signerCount: signers,
            blockPublishers,
            blockDeliveries,
            receiverSyncBroadcasts: 0,
            senderSyncBroadcasts: 0,
            aggregateBroadcasts,
            totalRequests: blockDeliveries + aggregateBroadcasts,
        }
    }

    // Stabilisation currently invokes broadcastNewBlock on every committee
    // member. Duplicate deliveries short-circuit at the receiver, so each
    // non-signer fans out its status once, while every signer still performs
    // its own sender-side status broadcast.
    const blockPublishers = signers
    const blockDeliveries = blockPublishers * recipients
    const receiverSyncBroadcasts = blockDeliveries > 0 ? recipients * nodes : 0
    const senderSyncBroadcasts =
        blockDeliveries > 0 ? blockPublishers * nodes : 0
    return {
        nodeCount: nodes,
        signerCount: signers,
        blockPublishers,
        blockDeliveries,
        receiverSyncBroadcasts,
        senderSyncBroadcasts,
        aggregateBroadcasts: 0,
        totalRequests:
            blockDeliveries + receiverSyncBroadcasts + senderSyncBroadcasts,
    }
}
