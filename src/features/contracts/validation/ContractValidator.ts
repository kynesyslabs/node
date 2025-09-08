/**
 * Contract validation utilities with TypeScript compilation support
 */

import crypto from "crypto"
import * as ts from "typescript"
import type { ContractData } from "@/features/contracts/types/ContractTypes"
import type { ContractABI } from "@/features/contracts/types/ContractABI"

// Contract size limits
export const MAX_CONTRACT_SIZE = 256 * 1024 // 256KB
export const MAX_STORAGE_SIZE = 64 * 1024   // 64KB
export const DEPLOYMENT_FEE_PER_32KB = 1    // 1 DEM per 32KB

// Banned APIs that contracts cannot use
const BANNED_APIS = [
    // File system
    "require('fs')", "import('fs')", "from 'fs'",
    "readFileSync", "writeFileSync", "readdirSync", "mkdirSync",
    
    // Network
    "require('http')", "require('https')", "from 'http'", "from 'https'",
    "fetch(", "XMLHttpRequest",
    
    // Process
    "process.exit", "process.kill", "process.env",
    "require('child_process')", "from 'child_process'",
    "spawn(", "exec(", "fork(",
    
    // Dangerous globals  
    "eval(", "Function(", "setTimeout(", "setInterval(",
    "__dirname", "__filename",
    
    // Module system abuse
    "require.cache", "module.exports",
    
    // Bun specific
    "Bun.spawn", "Bun.file", "Bun.write",
]

/**
 * Validates contract source code with TypeScript compilation
 */
export function validateContractSource(source: string): {
    valid: boolean
    error?: string
    warnings?: string[]
    compiledJS?: string
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

    // Validate TypeScript syntax and compilation
    const tsValidation = validateTypeScriptContract(source)
    if (!tsValidation.valid) {
        return tsValidation
    }

    // Check contract structure
    const structureValidation = validateContractStructure(source)
    if (!structureValidation.valid) {
        return structureValidation
    }

    return { 
        valid: true,
        compiledJS: tsValidation.compiledJS,
        warnings: tsValidation.warnings,
    }
}

/**
 * Validates TypeScript syntax and compiles to JavaScript
 */
function validateTypeScriptContract(source: string): {
    valid: boolean
    error?: string
    warnings?: string[]
    compiledJS?: string
} {
    try {
        // TypeScript compiler options for contracts
        const compilerOptions: ts.CompilerOptions = {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            strict: false, // Relaxed for validation
            noEmitOnError: false,
            skipLibCheck: true,
            declaration: false,
            sourceMap: false,
            removeComments: false,
        }

        // Simple compilation using transpileModule
        const result = ts.transpileModule(source, {
            compilerOptions,
            reportDiagnostics: true,
        })

        // Check for compilation errors
        const errors: string[] = []
        const warnings: string[] = []

        if (result.diagnostics) {
            result.diagnostics.forEach(diagnostic => {
                if (diagnostic.file && diagnostic.start !== undefined) {
                    const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
                    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
                    
                    if (diagnostic.category === ts.DiagnosticCategory.Error) {
                        errors.push(`Line ${line + 1}:${character + 1} - ${message}`)
                    } else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
                        warnings.push(`Line ${line + 1}:${character + 1} - ${message}`)
                    }
                } else {
                    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
                    if (diagnostic.category === ts.DiagnosticCategory.Error) {
                        errors.push(message)
                    } else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
                        warnings.push(message)
                    }
                }
            })
        }

        // Only fail on actual syntax/type errors, not missing module errors
        const realErrors = errors.filter(error => 
            !error.includes("Cannot find module") &&
            !error.includes("Cannot resolve") &&
            !error.includes("Module not found"),
        )

        if (realErrors.length > 0) {
            return {
                valid: false,
                error: `TypeScript compilation failed:\n${realErrors.join("\n")}`,
            }
        }

        return {
            valid: true,
            compiledJS: result.outputText,
            warnings: warnings.length > 0 ? warnings : undefined,
        }

    } catch (error) {
        return {
            valid: false,
            error: `TypeScript validation failed: ${error}`,
        }
    }
}

/**
 * Validates contract structure requirements
 */
function validateContractStructure(source: string): {
    valid: boolean
    error?: string
} {
    // Check for required class structure
    if (!source.includes("class") || !source.includes("extends DemosContract")) {
        return {
            valid: false,
            error: "Contract must extend DemosContract base class",
        }
    }

    // Check for proper import
    if (!source.includes("from \"../execution/ContractBase\"") && 
        !source.includes("from '../execution/ContractBase'")) {
        return {
            valid: false,
            error: "Contract must import DemosContract from '../execution/ContractBase'",
        }
    }

    // Check for export
    if (!source.includes("export class")) {
        return {
            valid: false,
            error: "Contract must export the contract class",
        }
    }

    // Check that class name ends with "Contract"
    const classMatch = source.match(/export\s+class\s+(\w+)\s+extends\s+DemosContract/)
    if (classMatch) {
        const className = classMatch[1]
        if (!className.endsWith("Contract")) {
            return {
                valid: false,
                error: "Contract class name must end with 'Contract'",
            }
        }
    } else {
        return {
            valid: false,
            error: "Could not find valid contract class declaration",
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