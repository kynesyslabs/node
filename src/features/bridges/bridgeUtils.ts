import { BLOCKCHAIN_NAME, CrossChainManagerCalculationOptions } from "rubic-sdk"

 
export const BRIDGE_PROTOCOLS = {
    ALL: "all",
    MULTICHAIN: "multichain",
    CELER: "celer",
    SYMBIOSIS: "symbiosis",
    AXELAR: "axelar",
    WORMHOLE: "wormhole",
} as const

export const RUBIC_API_REFERRER_ADDRESS =
    process.env.RUBIC_API_REFERRER_ADDRESS || "rubic.exchange"
export const RUBIC_API_INTEGRATOR_ADDRESS =
    process.env.RUBIC_API_INTEGRATOR_ADDRESS ||
    "0x069eA739d1125eDed11663Ba55E0b83277D42885"
export const RUBIC_API_V2_BASE_URL = "https://api-v2.rubic.exchange/api"
export const RUBIC_API_V2_ROUTES = {
    QUOTE_BEST: `${RUBIC_API_V2_BASE_URL}/routes/quoteBest`,
    SWAP: `${RUBIC_API_V2_BASE_URL}/routes/swap`,
}

export interface ExtendedCrossChainManagerCalculationOptions
    extends CrossChainManagerCalculationOptions {
    bridgeTypes?: string[]
}

export type BlockchainName =
    (typeof BLOCKCHAIN_NAME)[keyof typeof BLOCKCHAIN_NAME]

export type BridgeProtocol = keyof typeof BRIDGE_PROTOCOLS
