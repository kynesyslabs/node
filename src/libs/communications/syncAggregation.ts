import type Block from "../blockchain/block"

export const SYNC_AGGREGATE_VERSION = 1 as const
export const SYNC_AGGREGATE_V2_VERSION = 2 as const
export const MAX_SYNC_AGGREGATE_IDENTITIES = 1000
export const MAX_SYNC_AGGREGATE_IDENTITY_LENGTH = 256
// 4096 bytes covers 32,768 committed peerlist entries; anything larger is
// rejected before decoding so a hostile aggregate cannot force allocation.
export const MAX_SYNC_AGGREGATE_BITMAP_BYTES = 4096

export interface BlockSyncAggregateV1 {
    version: typeof SYNC_AGGREGATE_VERSION
    blockNumber: number
    blockHash: string
    syncedPeerIds: string[]
}

/**
 * Version 2 encodes acknowledgements as a bitmap over the canonical index of
 * the block's committed peerlist instead of a JSON identity list. The
 * peerlist is inside the block-hash preimage, so every node holding the block
 * derives the identical index locally and no identities travel on the wire.
 * `validation_data.signatures` is deliberately NOT part of the index: the
 * signature map is merged incrementally per node and is not hash-covered, so
 * it can differ between nodes holding the same block.
 */
export interface BlockSyncAggregateV2 {
    version: typeof SYNC_AGGREGATE_V2_VERSION
    blockNumber: number
    blockHash: string
    /** Expected canonical index length; cheap cross-check before decoding. */
    peerlistSize: number
    /** Base64 bitmap, bit i = canonical index entry i acknowledged the block. */
    ackBits: string
}

export type BlockSyncAggregate = BlockSyncAggregateV1 | BlockSyncAggregateV2

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
 * Canonical acknowledgement index for a block: the committed peerlist
 * identities, normalized, deduplicated and sorted. The committed peerlist is
 * part of the block-hash preimage, so every node holding the block computes
 * the identical index. Handles both committed entry shapes (identity strings
 * and legacy `{ identity }` objects).
 */
export function canonicalAckIndex(block: SyncAggregateBlockView): string[] {
    const committedPeerlist = Array.isArray(block.content?.peerlist)
        ? block.content.peerlist
        : []
    const identities = new Set<string>()
    for (const entry of committedPeerlist) {
        let identity: string | null = null
        if (typeof entry === "string") {
            identity = entry
        } else if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { identity?: unknown }).identity === "string"
        ) {
            identity = (entry as { identity: string }).identity
        }
        if (identity && isBoundedIdentity(identity)) {
            identities.add(normalizeIdentity(identity))
        }
    }
    return [...identities].sort()
}

/** Pack acknowledgement flags LSB-first into a base64 bitmap. */
export function encodeAckBits(flags: boolean[]): string {
    const bytes = new Uint8Array(Math.ceil(flags.length / 8))
    for (let i = 0; i < flags.length; i++) {
        if (flags[i]) bytes[i >> 3] |= 1 << (i & 7)
    }
    return Buffer.from(bytes).toString("base64")
}

/**
 * Decode a base64 acknowledgement bitmap. Returns null unless the payload is
 * canonical: strict base64, exactly ceil(expectedSize / 8) bytes, and every
 * bit beyond expectedSize cleared.
 */
export function decodeAckBits(
    ackBits: string,
    expectedSize: number,
): boolean[] | null {
    if (
        typeof ackBits !== "string" ||
        expectedSize <= 0 ||
        expectedSize > MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8 ||
        ackBits.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(ackBits)
    ) {
        return null
    }
    const bytes = Buffer.from(ackBits, "base64")
    if (bytes.length !== Math.ceil(expectedSize / 8)) return null
    // Reject non-canonical re-encodings (base64 that decodes to the right
    // bytes but was not produced by Buffer's encoder, e.g. junk in padding).
    if (Buffer.from(bytes).toString("base64") !== ackBits) return null
    const flags: boolean[] = new Array(expectedSize)
    for (let i = 0; i < expectedSize; i++) {
        flags[i] = (bytes[i >> 3] & (1 << (i & 7))) !== 0
    }
    for (let i = expectedSize; i < bytes.length * 8; i++) {
        if ((bytes[i >> 3] & (1 << (i & 7))) !== 0) return null
    }
    return flags
}

/**
 * Build the version-2 bitmap aggregate from block delivery responses.
 * Returns null when the block commits no usable peerlist (or one too large
 * to represent); callers should fall back to the version-1 list shape.
 */
export function buildSyncAggregateV2(
    block: Pick<Block, "number" | "hash" | "content">,
    senderIdentity: string,
    responses: SyncResponseLike[],
): BlockSyncAggregateV2 | null {
    const index = canonicalAckIndex(block as unknown as SyncAggregateBlockView)
    if (
        index.length === 0 ||
        index.length > MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8
    ) {
        return null
    }
    const position = new Map(index.map((identity, i) => [identity, i]))
    const flags: boolean[] = new Array(index.length).fill(false)

    const senderPosition = position.get(normalizeIdentity(senderIdentity))
    if (senderPosition !== undefined) flags[senderPosition] = true

    for (const response of responses) {
        const syncData = extractSyncData(response)
        if (
            !syncData ||
            !syncDataMatchesBlock(syncData, block.number, block.hash)
        ) {
            continue
        }
        const claimedPosition = position.get(normalizeIdentity(response.pubkey))
        if (claimedPosition !== undefined) flags[claimedPosition] = true
    }

    return {
        version: SYNC_AGGREGATE_V2_VERSION,
        blockNumber: block.number,
        blockHash: block.hash,
        peerlistSize: index.length,
        ackBits: encodeAckBits(flags),
    }
}

// Base64 of MAX_SYNC_AGGREGATE_BITMAP_BYTES is 4 * ceil(4096 / 3) characters.
const MAX_ACK_BITS_LENGTH = 4 * Math.ceil(MAX_SYNC_AGGREGATE_BITMAP_BYTES / 3)

export function isBlockSyncAggregateV2(
    value: unknown,
): value is BlockSyncAggregateV2 {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    const aggregate = value as Record<string, unknown>
    return (
        aggregate.version === SYNC_AGGREGATE_V2_VERSION &&
        typeof aggregate.blockNumber === "number" &&
        Number.isSafeInteger(aggregate.blockNumber) &&
        aggregate.blockNumber >= 0 &&
        typeof aggregate.blockHash === "string" &&
        aggregate.blockHash.length > 0 &&
        aggregate.blockHash.length <= 256 &&
        typeof aggregate.peerlistSize === "number" &&
        Number.isSafeInteger(aggregate.peerlistSize) &&
        aggregate.peerlistSize > 0 &&
        aggregate.peerlistSize <= MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8 &&
        typeof aggregate.ackBits === "string" &&
        aggregate.ackBits.length <= MAX_ACK_BITS_LENGTH
    )
}

/**
 * Validate a relayed acknowledgement set against a block already verified by
 * the receiver. The aggregate cannot add an identity to the peer set, mark an
 * identity online, or describe a block absent from the receiver's chain.
 * Accepts both wire versions so mixed fleets converge during rollout.
 */
export function admitSyncAggregate(
    value: unknown,
    block: SyncAggregateBlockView | null,
    senderIdentity: string,
    localIdentity: string,
    knownPeerIdentities: string[],
): SyncAggregateAdmission {
    let claimedIdentities: string[]
    let cachedIndex: string[] | null = null
    if (isBlockSyncAggregateV2(value)) {
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
        const index = canonicalAckIndex(block)
        cachedIndex = index
        if (index.length === 0 || index.length !== value.peerlistSize) {
            return {
                ok: false,
                status: 400,
                message: "Sync aggregate peerlist index mismatch",
            }
        }
        const flags = decodeAckBits(value.ackBits, index.length)
        if (!flags) {
            return {
                ok: false,
                status: 400,
                message: "Invalid sync aggregate bitmap",
            }
        }
        claimedIdentities = index.filter((_, i) => flags[i])
    } else if (isBlockSyncAggregateV1(value)) {
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
        claimedIdentities = value.syncedPeerIds
    } else {
        return {
            ok: false,
            status: 400,
            message: "Invalid sync aggregate",
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
    for (const identity of cachedIndex ?? canonicalAckIndex(block)) {
        eligibleIds.add(identity)
    }

    const local = normalizeIdentity(localIdentity)
    const knownIds = new Set(knownPeerIdentities.map(normalizeIdentity))
    const acceptedPeerIds: string[] = []
    const seen = new Set<string>()
    for (const claimedIdentity of claimedIdentities) {
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
 * Stable partition slot for an identity. The assignment depends only on the
 * identity, the partition count and the optional seed — never on peerlist
 * ordering, which differs between nodes. Passing the block hash as the seed
 * rotates slot ownership every block, so a faulty or withholding committee
 * member cannot starve the same delivery slice round after round.
 */
export function partitionIndexFor(
    identity: string,
    partitionCount: number,
    seed = "",
): number {
    if (partitionCount <= 0) return 0
    const normalized = normalizeIdentity(identity)
    if (seed === "") {
        const hexTail = normalized.replace(/^0x/, "").slice(-8)
        if (/^[0-9a-f]{1,8}$/.test(hexTail)) {
            return Number.parseInt(hexTail, 16) % partitionCount
        }
    }
    const keyed = seed === "" ? normalized : `${normalized}:${seed}`
    let acc = 0
    for (let i = 0; i < keyed.length; i++) {
        acc = (acc * 31 + keyed.charCodeAt(i)) >>> 0
    }
    return acc % partitionCount
}

/**
 * The delivery slice a committee member owns under version-2 partitioned
 * block publication. Callers must pass only the committee members that
 * signed the block: a member that aborted mid-round holds neither the block
 * nor a delivery duty and must stay eligible to RECEIVE the block through
 * someone's slice. Passed members are excluded from every slice (consensus
 * already gave them the block). Returns null when the local node has no
 * delivery duty. Every member computes only its own slice, so divergent
 * peer views degrade to duplicate or missed deliveries that the receiver
 * dedupe and the retained anti-entropy path already handle.
 */
export function blockDeliveryPartition(
    localIdentity: string,
    committeeIdentities: string[],
    peerIdentities: string[],
    seed = "",
): string[] | null {
    const committee = [
        ...new Set(
            committeeIdentities
                .filter(
                    identity =>
                        typeof identity === "string" &&
                        isBoundedIdentity(identity),
                )
                .map(normalizeIdentity),
        ),
    ].sort()
    const localIndex = committee.indexOf(normalizeIdentity(localIdentity))
    if (localIndex === -1) return null

    const committeeSet = new Set(committee)
    return peerIdentities.filter(identity => {
        const normalized = normalizeIdentity(identity)
        return (
            !committeeSet.has(normalized) &&
            partitionIndexFor(normalized, committee.length, seed) ===
                localIndex
        )
    })
}

/**
 * Whether the aggregation path is active for a given block height. The
 * activation height lets a mixed-version fleet flip behaviour at one
 * coordinated block instead of on process restart.
 */
export function syncAggregationActiveAt(
    enabled: boolean,
    activationHeight: number,
    blockNumber: number,
): boolean {
    if (!enabled) return false
    const height =
        Number.isSafeInteger(activationHeight) && activationHeight > 0
            ? activationHeight
            : 0
    return blockNumber >= height
}

/**
 * Model the post-block request burst. This deliberately excludes periodic
 * anti-entropy because it is not triggered once per block.
 */
export function estimatePostBlockTraffic(
    nodeCount: number,
    signerCount: number,
    aggregateEnabled: boolean,
    aggregateVersion: 1 | 2 = 1,
): PostBlockTrafficEstimate {
    const nodes = Math.max(0, Math.floor(nodeCount))
    const signers = Math.min(nodes, Math.max(0, Math.floor(signerCount)))
    const recipients = nodes - signers

    if (aggregateEnabled && aggregateVersion === 2) {
        // Every signer delivers the block to its deterministic slice, so the
        // delivery total is unchanged while per-sender load divides by the
        // committee size. Each signer then broadcasts its own tiny partial
        // bitmap aggregate to every other node.
        const blockPublishers = signers
        const blockDeliveries = signers > 0 ? recipients : 0
        const aggregateBroadcasts =
            blockDeliveries > 0 || signers > 1
                ? signers * Math.max(0, nodes - 1)
                : 0
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
