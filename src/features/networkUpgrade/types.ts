// Governance types re-exported from the SDK. Phase 1 types were originally
// authored here before SDK Batch 2 landed; they are now owned by
// @kynesyslabs/demosdk and this module is a thin surface to keep internal
// imports stable.

export type {
    NetworkParameters,
    NetworkParameterKey,
    NetworkUpgradeProposal,
    ProposalStatus,
    ProposalVoteInfo,
} from "@kynesyslabs/demosdk/types"
