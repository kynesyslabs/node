/**
 * Contract ABI type definitions and utilities
 */

/**
 * Supported TypeScript types for contract methods
 */
export type ContractType = 
    | "string"
    | "number"
    | "bigint"
    | "boolean"
    | "any"
    | "void"
    | "string[]"
    | "number[]"
    | "bigint[]"
    | "boolean[]"
    | "Record<string, any>"
    | "Date"

/**
 * Method parameter definition
 */
export interface ABIParameter {
    name: string
    type: ContractType
}

/**
 * Method output definition
 */
export interface ABIOutput {
    type: ContractType
}

/**
 * Contract method definition
 */
export interface ABIMethod {
    name: string
    inputs: ABIParameter[]
    outputs: ABIOutput[]
    stateMutability: "view" | "nonpayable" | "payable"
}

/**
 * Contract event parameter
 */
export interface ABIEventParameter {
    name: string
    type: ContractType
    indexed?: boolean
}

/**
 * Contract event definition
 */
export interface ABIEvent {
    name: string
    inputs: ABIEventParameter[]
}

/**
 * Contract constructor definition
 */
export interface ABIConstructor {
    inputs: ABIParameter[]
}

/**
 * Complete Contract ABI
 */
export interface ContractABI {
    methods: ABIMethod[]
    events: ABIEvent[]
    constructor?: ABIConstructor
}

/**
 * Validates that a value matches the expected ContractType
 */
export function validateType(value: any, type: ContractType): boolean {
    switch (type) {
        case "string":
            return typeof value === "string"
        case "number":
            return typeof value === "number" && !isNaN(value)
        case "bigint":
            return typeof value === "bigint"
        case "boolean":
            return typeof value === "boolean"
        case "any":
            return true
        case "void":
            return value === undefined || value === null
        case "string[]":
            return Array.isArray(value) && value.every(v => typeof v === "string")
        case "number[]":
            return Array.isArray(value) && value.every(v => typeof v === "number" && !isNaN(v))
        case "bigint[]":
            return Array.isArray(value) && value.every(v => typeof v === "bigint")
        case "boolean[]":
            return Array.isArray(value) && value.every(v => typeof v === "boolean")
        case "Record<string, any>":
            return typeof value === "object" && value !== null && !Array.isArray(value)
        case "Date":
            return value instanceof Date
        default:
            return false
    }
}

/**
 * Validates method arguments against ABI
 */
export function validateMethodArgs(
    args: any[], 
    method: ABIMethod
): { valid: boolean; error?: string } {
    if (args.length !== method.inputs.length) {
        return { 
            valid: false, 
            error: `Expected ${method.inputs.length} arguments, got ${args.length}` 
        }
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const input = method.inputs[i]
        
        if (!validateType(arg, input.type)) {
            return {
                valid: false,
                error: `Argument ${input.name} at position ${i} expected type ${input.type}`
            }
        }
    }

    return { valid: true }
}

/**
 * Generates a TypeScript interface from ContractABI
 * Used for SDK type generation
 */
export function generateTypeScriptInterface(
    contractName: string, 
    abi: ContractABI
): string {
    let interface_ = `export interface ${contractName}Contract {\n`
    
    // Add constructor if exists
    if (abi.constructor) {
        const params = abi.constructor.inputs
            .map(p => `${p.name}: ${p.type}`)
            .join(", ")
        interface_ += `  constructor(${params}): void\n`
    }
    
    // Add methods
    for (const method of abi.methods) {
        const params = method.inputs
            .map(p => `${p.name}: ${p.type}`)
            .join(", ")
        const returnType = method.outputs.length === 0 
            ? "void" 
            : method.outputs[0].type
        
        interface_ += `  ${method.name}(${params}): ${returnType}\n`
    }
    
    interface_ += "}\n"
    
    return interface_
}