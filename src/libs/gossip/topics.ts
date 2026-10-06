export const HEIGHTS_TOPIC = "demos/heights/1"
export const BLOCKS_TOPIC = "demos/blocks/1"
export const TXS_TOPIC = "demos/txs/1"

export const HEIGHTS_MAX_BYTES = 1024
export const BLOCKS_MAX_BYTES = 1024 * 1024 + 4096
/**
 * One ValidityData envelope per message. The largest tx observed on
 * mainnet is ~81 KB (storageProgram with 40 KB of gcr_edits); 256 KB is
 * 3x that with room for the envelope, and a quarter of the block cap so a
 * single tx can never be what makes a block message oversized.
 */
export const TXS_MAX_BYTES = 256 * 1024

/**
 * Tx topic limits, sized for ~500 txs per 10 s block network-wide. One
 * popular validator RPC may legitimately front all of it, so per-publisher
 * limits allow the whole expected load on one key with headroom, while a
 * compromised key stays bounded.
 */
export const TXS_PUBLISHER_RATE_PER_SEC = 200
export const TXS_PUBLISHER_BURST = 1000
export const TXS_PUBLISHER_BYTES_PER_SEC = 5 * 1024 * 1024
export const TXS_PUBLISHER_BYTES_BURST = 50 * 1024 * 1024
export const TXS_GLOBAL_RATE_PER_SEC = 1000
export const TXS_GLOBAL_BURST = 2000
