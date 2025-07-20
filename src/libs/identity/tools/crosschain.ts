import axios from "axios"
import {
    EthTransactionResponse,
    EthTransaction,
    SolanaTransactionResponse,
} from "@kynesyslabs/demosdk/types"

export class CrossChainTools {
    private static readonly ETHERSCAN_BASE_URL =
        "https://api.etherscan.io/v2/api"
    private static readonly HELIUS_BASE_URL = "https://api.helius.xyz/v0"

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
        offset = 1,
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

    /**
     * Get Solana transactions by address using Helius API
     * @param address - The Solana address to query
     * @param limit - Number of transactions to return (default: 100)
     * @param before - Transaction signature to paginate before
     * @param until - Transaction signature to paginate until
     * @returns Promise<SolanaTransactionResponse>
     */
    static async getSolanaTransactionsByAddress(
        address: string,
        limit = 1,
        before?: string,
        until?: string,
    ): Promise<SolanaTransactionResponse> {
        const apiKey = process.env.HELIUS_API_KEY
        if (!apiKey) {
            throw new Error("HELIUS_API_KEY environment variable is not set")
        }

        const params: any = {
            "api-key": apiKey,
            limit: limit.toString(),
        }

        if (before) params.before = before
        if (until) params.until = until

        try {
            const response = await axios.get(
                `${this.HELIUS_BASE_URL}/addresses/${address}/transactions`,
                { params },
            )

            if (response.status === 404) {
                return []
            }

            return response.data as SolanaTransactionResponse
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(
                    `Failed to fetch Solana transactions: ${error.message}`,
                )
            }

            throw new Error(
                `Failed to fetch Solana transactions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }

    /**
     * Count Solana transactions by address using Helius API
     * @param address - The Solana address to query
     * @returns Promise<number>
     */
    static async countSolanaTransactionsByAddress(
        address: string,
    ): Promise<number> {
        try {
            const response = await this.getSolanaTransactionsByAddress(address)
            return Array.isArray(response)
                ? response.length
                : (response as any).length || 0
        } catch (error) {
            throw new Error(
                `Failed to count Solana transactions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }
}
