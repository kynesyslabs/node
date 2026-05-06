// REVIEW: P2/P3b — public surface for the forks module.

export { isForkActive } from "./forkGates"
export {
    serializeTransactionContent,
    serializeBlockContent,
} from "./serializerGate"
export {
    DEFAULT_FORK_CONFIG,
    cloneDefaultForkConfig,
} from "./forkConfig"
export { loadForkConfigFromGenesis } from "./loadForkConfig"
export type { ForkName, ForkConfig } from "./forkConfig"
export {
    runOsDenominationMigration,
    isOsDenominationMigrationApplied,
    FORK_NAME as OS_DENOMINATION_FORK_NAME,
    LEGACY_NUMBER_CAP,
} from "./migrations/osDenomination"
export type { OsDenominationMigrationResult } from "./migrations/osDenomination"
