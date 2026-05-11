import { BLOCKCHAIN_NAME, CrossChainManagerCalculationOptions } from "rubic-sdk"
import { Config } from "src/config"

// eslint-disable-next-line @typescript-eslint/naming-convention
export const BRIDGE_PROTOCOLS = {
    ALL: "all",
    MULTICHAIN: "multichain",
    CELER: "celer",
    SYMBIOSIS: "symbiosis",
    AXELAR: "axelar",
    WORMHOLE: "wormhole",
} as const

export const RUBIC_API_REFERRER_ADDRESS =
    Config.getInstance().bridges.rubicApiReferrerAddress
export const RUBIC_API_INTEGRATOR_ADDRESS =
    Config.getInstance().bridges.rubicApiIntegratorAddress
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
