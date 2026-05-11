// REVIEW: P2/P3b + DEM-665 — public surface for the forks module.

export { isForkActive } from "./forkGates"
export {
    serializeTransactionContent,
    serializeBlockContent,
} from "./serializerGate"
export {
    DEFAULT_FORK_CONFIG,
    PLACEHOLDER_TREASURY_ADDRESS,
    cloneDefaultForkConfig,
} from "./forkConfig"
export {
    loadForkConfigFromGenesis,
    ForkConfigValidationError,
    GAS_FEE_SEPARATION_BURN_ADDRESS,
} from "./loadForkConfig"
export type {
    ForkName,
    ForkConfig,
    ForkConfigByName,
    BaseForkConfig,
    OsDenominationConfig,
    GasFeeSeparationConfig,
} from "./forkConfig"
export {
    runOsDenominationMigration,
    isOsDenominationMigrationApplied,
    FORK_NAME as OS_DENOMINATION_FORK_NAME,
    LEGACY_NUMBER_CAP,
} from "./migrations/osDenomination"
export type { OsDenominationMigrationResult } from "./migrations/osDenomination"
