/**
 * Contract validation utilities
 */

import crypto from "crypto"
import type { ContractData } from "@/features/contracts/types/ContractTypes"
import type { ContractABI } from "@/features/contracts/types/ContractABI"

// Contract size limits
export const MAX_CONTRACT_SIZE = 256 * 1024 // 256KB
export const MAX_STORAGE_SIZE = 64 * 1024   // 64KB
export const DEPLOYMENT_FEE_PER_32KB = 1    // 1 DEM per 32KB

// Banned APIs that contracts cannot use
const BANNED_APIS = [
    // File system
    "fs", "require('fs')", "import('fs')",
    "readFile", "writeFile", "readdir", "mkdir",
    
    // Network
    "http", "https", "net", "dgram",
    "require('http')", "require('https')",
    "fetch", "XMLHttpRequest",
    
    // Process
    "process.exit", "process.kill", "process.env",
    "child_process", "spawn", "exec", "fork",
    
    // Dangerous globals
    "eval", "Function", "setTimeout", "setInterval",
    "__dirname", "__filename",
    
    // Module system abuse
    "require.cache", "module.exports",
    
    // Bun specific
    "Bun.spawn", "Bun.file", "Bun.write",
]

/**
 * Validates contract source code
 */
export function validateContractSource(source: string): { 
    valid: boolean
    error?: string 
} {
    // Check size
    const sizeInBytes = new TextEncoder().encode(source).length
    if (sizeInBytes > MAX_CONTRACT_SIZE) {
        return {
            valid: false,
            error: `Contract size ${sizeInBytes} bytes exceeds maximum ${MAX_CONTRACT_SIZE} bytes`,
        }
    }

    // Check for banned APIs
    for (const banned of BANNED_APIS) {
        if (source.includes(banned)) {
            return {
                valid: false,
                error: `Contract contains banned API: ${banned}`,
            }
        }
    }

    // Basic syntax check (will be validated more thoroughly during execution)
    try {
        // Check if it's valid TypeScript by attempting to parse
        // In production, we'd use the TypeScript compiler API
        if (!source.includes("class") || !source.includes("extends DemosContract")) {
            return {
                valid: false,
                error: "Contract must extend DemosContract base class",
            }
        }
    } catch (e) {
        return {
            valid: false,
            error: "Invalid TypeScript syntax",
        }
    }

    return { valid: true }
}

/**
 * Validates contract storage size
 */
export function validateStorageSize(storage: Record<string, any>): {
    valid: boolean
    error?: string
    sizeInBytes?: number
} {
    const storageString = JSON.stringify(storage)
    const sizeInBytes = new TextEncoder().encode(storageString).length
    
    if (sizeInBytes > MAX_STORAGE_SIZE) {
        return {
            valid: false,
            error: `Storage size ${sizeInBytes} bytes exceeds maximum ${MAX_STORAGE_SIZE} bytes`,
            sizeInBytes,
        }
    }

    return { valid: true, sizeInBytes }
}

/**
 * Generates checksum for contract code
 */
export function generateContractChecksum(source: string): string {
    return crypto.createHash("sha256").update(source).digest("hex")
}

/**
 * Validates complete contract data
 */
export function validateContractData(contract: ContractData): {
    valid: boolean
    errors: string[]
} {
    const errors: string[] = []

    // Validate source code
    const sourceValidation = validateContractSource(contract.code.source)
    if (!sourceValidation.valid && sourceValidation.error) {
        errors.push(sourceValidation.error)
    }

    // Validate checksum
    const expectedChecksum = generateContractChecksum(contract.code.source)
    if (contract.code.checksum !== expectedChecksum) {
        errors.push("Contract checksum mismatch")
    }

    // Validate storage
    const storageValidation = validateStorageSize(contract.state.storage)
    if (!storageValidation.valid && storageValidation.error) {
        errors.push(storageValidation.error)
    }

    // Validate ABI
    if (!contract.code.abi || !Array.isArray(contract.code.abi.methods)) {
        errors.push("Invalid or missing contract ABI")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Calculates deployment fee based on contract size
 */
export function calculateDeploymentFee(source: string): bigint {
    const sizeInBytes = new TextEncoder().encode(source).length
    const chunks = Math.ceil(sizeInBytes / (32 * 1024)) // Round up to 32KB chunks
    return BigInt(chunks * DEPLOYMENT_FEE_PER_32KB)
}

/**
 * Checks if a contract method is read-only (view)
 */
export function isReadOnlyMethod(abi: ContractABI, methodName: string): boolean {
    const method = abi.methods.find(m => m.name === methodName)
    return method?.stateMutability === "view"
}

/**
 * REVIEW: Contract validation utilities for ensuring security and limits
 * These validators are critical for maintaining contract safety
 */