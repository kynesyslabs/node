// REVIEW: P2 — public surface for the forks module.

export { isForkActive } from "./forkGates"
export {
    serializeTransactionContent,
    serializeBlockContent,
} from "./serializerGate"
export {
    DEFAULT_FORK_CONFIG,
    cloneDefaultForkConfig,
} from "./forkConfig"
export type { ForkName, ForkConfig } from "./forkConfig"
