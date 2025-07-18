import {
    EthTransactionResponse,
    EthTransaction,
} from "@kynesyslabs/demosdk/types"
import axios from "axios"

export class CrossChainTools {
    private static readonly ETHERSCAN_BASE_URL =
        "https://api.etherscan.io/v2/api"

    /**
     * Get Ethereum transactions by address using Etherscan API
     * @param address - The Ethereum address to query
     * @param chainId - The chain ID (1 for mainnet, 11155111 for sepolia, etc.)
     * @param page - Page number for pagination (default: 1)
     * @param offset - Number of transactions per page (default: 5)
     * @param startBlock - Starting block number (default: 0)
     * @param endBlock - Ending block number (default: 99999999)
     * @returns Promise<EthTransactionResponse>
     */
    static async getEthTransactionsByAddress(
        address: string,
        chainId: number,
        page = 1,
        offset = 5,
        startBlock = 0,
        endBlock = 99999999,
    ): Promise<EthTransactionResponse> {
        const apiKey = process.env.ETHERSCAN_API_KEY
        if (!apiKey) {
            throw new Error("ETHERSCAN_API_KEY environment variable is not set")
        }

        const params = {
            chainid: chainId.toString(),
            module: "account",
            action: "txlist",
            address: address,
            startblock: startBlock.toString(),
            endblock: endBlock.toString(),
            page: page.toString(),
            offset: offset.toString(),
            sort: "asc",
            apikey: apiKey,
        }

        try {
            const response = await axios.get(this.ETHERSCAN_BASE_URL, {
                params,
            })
            const data = response.data

            if (
                data.status !== "1" &&
                data.message !== "No transactions found"
            ) {
                throw new Error(`Etherscan API error: ${data.message}`)
            }

            return {
                status: data.status,
                message: data.message,
                result: data.result as EthTransaction[],
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(
                    `Failed to fetch transactions: ${error.message}`,
                )
            }
            throw new Error(
                `Failed to fetch transactions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }

    /**
     * Count Ethereum transactions by address using Etherscan API
     * @param address - The Ethereum address to query
     * @param chainId - The chain ID (1 for mainnet, 11155111 for sepolia, etc.)
     * @returns Promise<number>
     */
    static async countEthTransactionsByAddress(
        address: string,
        chainId: number,
    ): Promise<number> {
        try {
            const response = await this.getEthTransactionsByAddress(
                address,
                chainId,
                1,
                10000,
                0,
                99999999,
            )

            return response.result.length
        } catch (error) {
            throw new Error(
                `Failed to count transactions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }

    static async getSolanaTransactionsByAddress(address: string) {}

    static async countSolanaTransactionsByAddress(address: string) {}
}
