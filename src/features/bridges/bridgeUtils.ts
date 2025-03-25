import { BLOCKCHAIN_NAME, CrossChainManagerCalculationOptions } from "rubic-sdk"

export const BRIDGE_PROTOCOLS = {
    ALL: "all",
    MULTICHAIN: "multichain",
    CELER: "celer",
    SYMBIOSIS: "symbiosis",
    AXELAR: "axelar",
    WORMHOLE: "wormhole",
} as const

export interface ExtendedCrossChainManagerCalculationOptions
    extends CrossChainManagerCalculationOptions {
    bridgeTypes?: string[]
}

export type BlockchainName =
    (typeof BLOCKCHAIN_NAME)[keyof typeof BLOCKCHAIN_NAME]

export type BridgeProtocol = keyof typeof BRIDGE_PROTOCOLS
