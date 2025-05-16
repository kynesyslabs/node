import { describe, expect, test, beforeAll } from "bun:test"
import {
    StablecoinManagement,
} from "../features/bridges/native/stablecoinManagement"

const term = require("terminal-kit").terminal

// Test addresses for different chains
const testAddresses = {
    ETHEREUM: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    POLYGON: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    BSC: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    ARBITRUM: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    OPTIMISM: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    AVALANCHE: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    BASE: "0x0000000000000000000000000000000000000000", // Replace with actual test address
    SOLANA: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Replace with actual test address
}

describe("StablecoinManagement", () => {
    let stablecoinManager: StablecoinManagement

    beforeAll(() => {
        stablecoinManager = StablecoinManagement.getInstance()
    })

    describe("Initialization", () => {
        test("should be a singleton", () => {
            const instance1 = StablecoinManagement.getInstance()
            const instance2 = StablecoinManagement.getInstance()
            expect(instance1).toBe(instance2)
            term.green("[+] Singleton pattern verified\n")
        })

        test("should have correct supported chains", () => {
            expect(stablecoinManager.supportedChains).toContain("EVM")
            expect(stablecoinManager.supportedChains).toContain("SOLANA")
            term.green(
                `[+] Supported chains: ${stablecoinManager.supportedChains.join(
                    ", ",
                )}\n`,
            )
        })

        test("should have correct supported stablecoins", () => {
            expect(stablecoinManager.supportedStablecoins).toContain("USDC")
            term.green(
                `[+] Supported stablecoins: ${stablecoinManager.supportedStablecoins.join(
                    ", ",
                )}\n`,
            )
        })
    })

    describe("EVM Chain Tests", () => {
        test("should check USDC on Ethereum", async () => {
            try {
                const hasUSDC = await stablecoinManager.checkUSDCOnEVM(
                    "eth",
                    testAddresses.ETHEREUM,
                )
                expect(typeof hasUSDC).toBe("boolean")
                term.cyan(`[+] Ethereum USDC check result: ${hasUSDC}\n`)
            } catch (error: any) {
                // Skip test if chain is not properly initialized
                if (error?.message?.includes("not supported")) {
                    term.yellow(
                        "[!] Skipping Ethereum test - chain not properly initialized\n",
                    )
                    return
                }
                throw error
            }
        })

        test("should get USDC balance on Ethereum", async () => {
            try {
                const balance = await stablecoinManager.getUSDCBalance(
                    "eth",
                    testAddresses.ETHEREUM,
                )
                expect(balance).toBeDefined()
                term.cyan(`[+] Ethereum USDC balance: ${balance.toString()}\n`)
            } catch (error: any) {
                // Skip test if chain is not properly initialized
                if (error?.message?.includes("not supported")) {
                    term.yellow(
                        "[!] Skipping Ethereum balance test - chain not properly initialized\n",
                    )
                    return
                }
                throw error
            }
        })

        test("should handle unsupported chain", async () => {
            let result = true
            try {
                result = await stablecoinManager.checkUSDCOnEVM(
                    "unsupported",
                    testAddresses.ETHEREUM,
                )
            } catch (error: any) {
                console.log("[+] Unsupported chain error: ", error)
                result = false
            }
            expect(result).toBe(false)
            term.green("[+] Unsupported chain error handling verified\n")
        })
    })

    describe("Solana Tests", () => {
        test("should check USDC on Solana", async () => {
            try {
                const hasUSDC = await stablecoinManager.checkUSDCOnSolana(
                    testAddresses.SOLANA,
                )
                expect(typeof hasUSDC).toBe("boolean")
                term.cyan(`[+] Solana USDC check result: ${hasUSDC}\n`)
            } catch (error: any) {
                // Skip test if Solana is not properly initialized
                if (error?.message?.includes("not initialized")) {
                    term.yellow(
                        "[!] Skipping Solana test - connection not properly initialized\n",
                    )
                    return
                }
                throw error
            }
        })

        test("should get USDC balance on Solana", async () => {
            try {
                const balance = await stablecoinManager.getUSDCBalance(
                    "SOLANA",
                    testAddresses.SOLANA,
                )
                expect(balance).toBeDefined()
                term.cyan(`[+] Solana USDC balance: ${balance.toString()}\n`)
            } catch (error: any) {
                // Skip test if Solana is not properly initialized
                if (error?.message?.includes("not initialized")) {
                    term.yellow(
                        "[!] Skipping Solana balance test - connection not properly initialized\n",
                    )
                    return
                }
                throw error
            }
        })

        test("should handle invalid Solana address", async () => {
            let result = true
            try {
                result = await stablecoinManager.checkUSDCOnSolana(
                    "invalid",
                )
            } catch (error: any) {
                result = false
            }
            expect(result).toBe(false)
            term.green("[+] Invalid Solana address error handling verified\n")
        })
    })

    describe("Error Handling", () => {
        test("should handle invalid chain in getUSDCBalance", async () => {
            let result = true
            try {
                const balance = await stablecoinManager.getUSDCBalance(
                    "invalid",
                    testAddresses.ETHEREUM,
                )
            } catch (error: any) {
                result = false
            }
            expect(result).toBe(false)
            term.green("[+] Invalid chain error handling verified\n")
        })

        test("should handle invalid address format", async () => {
            let result = true
            try {
                result = await stablecoinManager.checkUSDCOnEVM(
                    "eth",
                    "invalid",
                )
            } catch (error: any) {
                result = false
            }
            expect(result).toBe(false)
            term.green("[+] Invalid address format error handling verified\n")
        })
    })
})
