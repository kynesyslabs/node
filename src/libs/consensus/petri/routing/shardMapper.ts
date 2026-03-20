/**
 * ShardMapper — Petri Consensus Phase 4
 *
 * Maps an address to a shard ID.
 * Single-shard testnet: always returns 'default'.
 * Interface designed for future multi-shard expansion.
 */

export type ShardId = string

/**
 * Get the shard responsible for a given address.
 *
 * @param _address - The account address (unused in single-shard mode)
 * @returns ShardId — always 'default' on testnet
 */
export function getShardForAddress(_address: string): ShardId {
    // Single-shard testnet: all addresses map to the same shard
    return "default"
}
