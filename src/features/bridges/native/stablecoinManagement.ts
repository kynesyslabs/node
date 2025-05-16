// REVIEW Is this module still needed? Should we do stuff in BridgingOperations and management classes?
// NOTE See tests/stablecoinManagement.spec.ts for more information

// This module will be used to check the stablecoins on the supported chains
import { ethers } from "ethers"
import * as solanaWeb3 from "@solana/web3.js"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { TransactionResponse } from "sdk/localsdk/multichain/types/multichain"
import { usdcContracts, usdcAbi } from "./supportedAssets"
import {
    supportedChains,
    supportedStablecoins,
    supportedEVMChains,
} from "./supportedAssets"

export class StablecoinManagement {
    private static instance: StablecoinManagement
    private evmInstances: Map<string, ethers.Contract> = new Map()
    private solanaConnection: solanaWeb3.Connection | null = null

    // Supported chains and stablecoins
    public supportedChains: typeof supportedChains = supportedChains
    public supportedStablecoins: typeof supportedStablecoins =
        supportedStablecoins

    // Singleton instance
    public static getInstance(): StablecoinManagement {
        if (!StablecoinManagement.instance) {
            StablecoinManagement.instance = new StablecoinManagement()
        }
        return StablecoinManagement.instance
    }

    private constructor() {
        // Initialize EVM instances
        this.initializeEVMInstances()
        // Initialize Solana connection
        this.initializeSolanaConnection()
    }

    private initializeEVMInstances() {
        // Initialize EVM instances for each supported chain using testnet providers
        const supportedChains = supportedEVMChains
        for (const chain of supportedChains) {
            const config = evmProviders[chain]
            if (!config) continue

            let providerUrl: string
            if ("sepolia" in config) {
                providerUrl = config.sepolia
            } else if ("testnet" in config) {
                providerUrl = config.testnet
            } else {
                console.warn(
                    `No testnet configuration found for chain ${chain}`,
                )
                continue
            }

            try {
                const provider = new ethers.JsonRpcProvider(providerUrl)
                // Map chain names to contract keys
                const contractKey =
                    chain.toUpperCase() === "ETH"
                        ? "ETHEREUM"
                        : chain.toUpperCase()
                const contractAddress = usdcContracts[contractKey]

                if (!contractAddress) {
                    console.warn(
                        `No USDC contract address found for chain ${chain}`,
                    )
                    continue
                }

                const contract = new ethers.Contract(
                    contractAddress,
                    usdcAbi,
                    provider,
                )
                this.evmInstances.set(chain, contract)
                console.log(`Successfully initialized contract for ${chain}`)
            } catch (error) {
                console.error(
                    `Failed to initialize contract for ${chain}:`,
                    error,
                )
            }
        }
    }

    private initializeSolanaConnection() {
        try {
            this.solanaConnection = new solanaWeb3.Connection(
                chainProviders.solana.devnet,
            )
        } catch (error) {
            console.error("Failed to initialize Solana connection:", error)
        }
    }

    public async checkUSDCOnSolana(address: string): Promise<boolean> {
        if (!this.solanaConnection) {
            throw new Error("Solana connection not initialized")
        }

        try {
            const tokenAccounts =
                await this.solanaConnection.getTokenAccountsByOwner(
                    new solanaWeb3.PublicKey(address),
                    { mint: new solanaWeb3.PublicKey(usdcContracts.SOLANA) },
                )
            return tokenAccounts.value.length > 0
        } catch (error) {
            console.error("Error checking USDC on Solana:", error)
            return false
        }
    }

    public async checkUSDCOnEVM(
        chain: string,
        address: string,
    ): Promise<boolean> {
        const contract = this.evmInstances.get(chain)
        if (!contract) {
            throw new Error(`Chain ${chain} not supported`)
        }

        try {
            const balance = await contract.balanceOf(address)
            return balance > 0
        } catch (error) {
            console.error(`Error checking USDC on ${chain}:`, error)
            return false
        }
    }

    public async getUSDCBalance(
        chain: string,
        address: string,
    ): Promise<bigint> {
        if (chain === "SOLANA") {
            if (!this.solanaConnection) {
                throw new Error("Solana connection not initialized")
            }
            const tokenAccounts =
                await this.solanaConnection.getTokenAccountsByOwner(
                    new solanaWeb3.PublicKey(address),
                    { mint: new solanaWeb3.PublicKey(usdcContracts.SOLANA) },
                )
            if (tokenAccounts.value.length === 0) return 0n
            const balance = await this.solanaConnection.getTokenAccountBalance(
                tokenAccounts.value[0].pubkey,
            )
            return BigInt(balance.value.amount)
        } else {
            const contract = this.evmInstances.get(chain)
            if (!contract) {
                throw new Error(`Chain ${chain} not supported`)
            }
            return await contract.balanceOf(address)
        }
    }
}
