import * as fs from "fs"
import log from "../utilities/logger"
import { NativeBridgeSupportedStablecoin } from "@kynesyslabs/demosdk/bridge"
import { SupportedChain } from "@kynesyslabs/demosdk/bridge/nativeBridgeTypes"

export class JsonConfig {
    static readonly USDC_CONTRACTS_PATH = "config/usdcContracts.json"
    static readonly PROVIDER_URLS_PATH = "config/providerUrls.json"
    static readonly TANK_ADDRESSES_PATH = "config/tankAddresses.json"
    static readonly TANK_ABIS_PATH = "config/abis/"
    static readonly BRIDGE_KEYS_PATH = "config/bridgePrivateKeys.json"
    static readonly EVMWSPROVIDERS_PATH = "config/EvmWSProviders.json"

    /**
     * Reads JSON data from a file given the path
     *
     * @param filePath - The path to the JSON file
     * @returns Parsed JSON data
     */
    static readJsonFromFile(filePath: string): any {
        try {
            const fileContent = fs.readFileSync(filePath, "utf8")
            return JSON.parse(fileContent)
        } catch (error) {
            throw new Error(
                `Failed to read JSON from file ${filePath}: ${error}`,
            )
        }
    }

    /**
     * Returns an object of chain identifiers mapped to subchains and their corresponding USDC contract addresses
     *
     * @returns USDC contracts configuration object
     */
    static getStableCoinContracts(): {
        [token: string]: {
            [chain: SupportedChain]: string
        }
    }
    static getStableCoinContracts(token: "all"): {
        [token: string]: {
            [chain: SupportedChain]: string
        }
    }
    static getStableCoinContracts(token: NativeBridgeSupportedStablecoin): {
        [chain: SupportedChain]: string
    }
    static getStableCoinContracts(
        token: NativeBridgeSupportedStablecoin | "all" = "all",
    ):
        | {
              [token: string]: {
                  [chain: SupportedChain]: string
              }
          }
        | {
              [chain: SupportedChain]: string
          } {
        const stableCoinContracts = this.readJsonFromFile(
            this.USDC_CONTRACTS_PATH,
        )
        if (token === "all") {
            return stableCoinContracts
        }

        return stableCoinContracts[token]
    }

    static getContractAddress(
        token: NativeBridgeSupportedStablecoin,
        chainKey: string,
    ): string | null {
        const usdcContracts = this.getStableCoinContracts(token)
        return usdcContracts[chainKey] || null
    }

    /**
     * Returns an object of chain identifiers mapped to subchains and their corresponding provider RPC URLs
     *
     * @returns Provider URLs configuration object
     */
    static getProviderUrls(): {
        [key: string]: {
            [key: string]: string
        }
    } {
        return this.readJsonFromFile(this.PROVIDER_URLS_PATH)
    }

    /**
     * Returns an object of chain keys mapped to their corresponding tank contract addresses
     *
     * @returns Tank addresses configuration object
     */
    static getTankAddresses(): {
        [chainKey: string]: string
    } {
        return this.readJsonFromFile(this.TANK_ADDRESSES_PATH)
    }

    /**
     * Returns an array of tank contract ABI for a given chain key
     *
     * @param chainKey Chain key (e.g., "evm.eth.sepolia")
     * @returns Tank ABI array or null if file not found
     */
    static getTankAbi(chainKey: string): string {
        const filePath = this.TANK_ABIS_PATH + chainKey + ".json"
        try {
            const tankAbis = this.readJsonFromFile(filePath)
            return tankAbis as string
        } catch (error) {
            log.error(`Failed to read tank ABI from file ${filePath}:` + error)
            process.exit(1)
            return null
        }
    }

    /**
     * Returns an object of chain keys mapped to their corresponding bridge keys
     *
     * @returns Bridge keys configuration object
     */
    static getBridgePrivateKey(chainKey: string): string | null {
        if (!fs.existsSync(this.BRIDGE_KEYS_PATH)) {
            log.error(
                `The bridge private key file ${this.BRIDGE_KEYS_PATH} does not exist`,
            )
            process.exit(1)
        }

        const bridgeKeys = this.readJsonFromFile(this.BRIDGE_KEYS_PATH)
        if (!bridgeKeys[chainKey]) {
            return null
        }

        return bridgeKeys[chainKey]
    }

    /**
     * Returns the WebSocket provider for a given chain key
     *
     * @param chainKey Chain key (e.g., "evm.eth.sepolia")
     * @returns WebSocket provider URL
     */
    static getWebSocketProvider(chainKey: string): string {
        const wsProviders = this.readJsonFromFile(this.EVMWSPROVIDERS_PATH)
        if (!wsProviders[chainKey]) {
            log.error(`WebSocket provider not found for chain: ${chainKey}`)
            process.exit(1)
        }

        return wsProviders[chainKey]
    }
}
