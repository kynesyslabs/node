import * as fs from "fs"
import log from "../utilities/logger"

export class JsonConfig {
    static readonly USDC_CONTRACTS_PATH = "config/usdcContracts.json"
    static readonly PROVIDER_URLS_PATH = "config/providerUrls.json"
    static readonly TANK_ADDRESSES_PATH = "config/tankAddresses.json"
    static readonly TANK_ABIS_PATH = "config/abis/"

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
    static getUsdcContracts(): {
        [key: string]: {
            [key: string]: string
        }
    } {
        return this.readJsonFromFile(this.USDC_CONTRACTS_PATH)
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
}
