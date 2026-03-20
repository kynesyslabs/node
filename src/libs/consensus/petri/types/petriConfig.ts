import type { ForgeConfig } from "./continuousForgeTypes"

/**
 * Top-level configuration for Petri Consensus.
 * All values have sensible defaults for testnet.
 */
export interface PetriConfig extends ForgeConfig {
    enabled: boolean // master switch (feature flag)
    blockIntervalMs: number // time between block finalizations (default: 10000)
    shardSize: number // expected shard size (default: 10)
}

/**
 * Default configuration — conservative values for initial testnet deployment.
 */
export const DEFAULT_PETRI_CONFIG: PetriConfig = {
    enabled: false,
    forgeIntervalMs: 2000,
    blockIntervalMs: 10000,
    agreementThreshold: 7,
    problematicTTLRounds: 5,
    shardSize: 10,
}
