/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Bun Worker script for isolated contract execution
 * This file runs in a separate Worker thread with restricted access
 */

import type {
    ExecutionRequest,
    ExecutionResult,
    CallCounter,
} from "./ExecutionContext"
import { DemosContract } from "./ContractBase"
import { createCallCountingProxy } from "./CallCountingProxy"

// REVIEW: Worker script for contract execution - runs in isolated thread
console.log("[SandboxExecutor] Worker thread initialized")

/**
 * Main worker message handler
 * Receives execution requests and returns results
 */
self.onmessage = async (event: MessageEvent<ExecutionRequest>) => {
    const request = event.data
    console.log(
        `[SandboxExecutor] Received execution request for method: ${request.methodName}`,
    )

    try {
        const result = await executeContract(request)
        self.postMessage(result)
    } catch (error) {
        console.error("[SandboxExecutor] Unhandled error:", error)
        const errorResult: ExecutionResult = {
            success: false,
            returnValue: null,
            callCount: 0,
            gasUsed: 0n,
            stateChanges: {},
            events: [],
            error: `Unhandled execution error: ${error}`,
        }
        self.postMessage(errorResult)
    }
}

/**
 * Execute contract method in sandboxed environment
 */
async function executeContract(
    request: ExecutionRequest,
): Promise<ExecutionResult> {
    const startTime = Date.now()
    const callCounter: CallCounter = { count: 0 }

    try {
        // 1. Create contract instance from source code
        console.log("[SandboxExecutor] Creating contract instance from source")
        const contractInstance = await createContractInstance(
            request.contractSource,
            request.executionContext,
            callCounter,
            request.contractState || {},
        )

        if (!contractInstance) {
            return {
                success: false,
                returnValue: null,
                callCount: callCounter.count,
                gasUsed: 0n,
                stateChanges: {},
                events: [],
                error: "Failed to create contract instance",
            }
        }

        // 2. Validate method exists
        if (
            typeof (contractInstance as any)[request.methodName] !== "function"
        ) {
            return {
                success: false,
                returnValue: null,
                callCount: callCounter.count,
                gasUsed: 0n,
                stateChanges: {},
                events: [],
                error: `Method '${request.methodName}' not found in contract`,
            }
        }

        // 3. Execute method with call counting
        console.log(`[SandboxExecutor] Executing method: ${request.methodName}`)
        const method = (contractInstance as any)[request.methodName]
        const returnValue = await method.apply(
            contractInstance,
            request.arguments,
        )

        // 4. Collect execution results
        const endTime = Date.now()
        const executionTimeMs = endTime - startTime

        // Calculate gas used (simplified: base fee + call count)
        const baseFee = 1000000000000000000n // 1 DEM in wei
        const gasUsed = baseFee + BigInt(callCounter.count) * baseFee

        // Get state changes and events from DemosContract base class
        const result: ExecutionResult = {
            success: true,
            returnValue,
            callCount: callCounter.count,
            gasUsed,
            stateChanges: contractInstance.__getStateChanges(),
            events: contractInstance.__getEvents(),
        }

        console.log(
            `[SandboxExecutor] Execution completed. Time: ${executionTimeMs}ms, Calls: ${callCounter.count}`,
        )
        return result
    } catch (error) {
        console.error("[SandboxExecutor] Contract execution error:", error)

        // Calculate partial gas for failed execution
        const baseFee = 1000000000000000000n
        const gasUsed = baseFee + BigInt(callCounter.count) * baseFee

        return {
            success: false,
            returnValue: null,
            callCount: callCounter.count,
            gasUsed,
            stateChanges: {},
            events: [],
            error: `Contract execution failed: ${error}`,
        }
    }
}

/**
 * Create contract instance from TypeScript source code
 * Dynamically evaluates user code and creates proxy wrapper
 */
async function createContractInstance(
    source: string,
    executionContext: any,
    callCounter: CallCounter,
    contractState: Record<string, any>,
): Promise<DemosContract | null> {
    try {
        // 1. Prepare execution environment
        // Create a safe evaluation context with restricted globals
        const safeGlobals = {
            console: {
                log: (...args: any[]) => console.log("[Contract]", ...args),
                error: (...args: any[]) => console.error("[Contract]", ...args),
                warn: (...args: any[]) => console.warn("[Contract]", ...args),
            },
            DemosContract,
            // Safe built-in objects
            Object,
            Array,
            String,
            Number,
            Boolean,
            Date,
            Math,
            JSON,
            BigInt,
            Map,
            Set,
            Promise,
            Error,
            TypeError,
            RangeError,
            SyntaxError,
        }

        // 2. Create function wrapper for contract source
        // This allows us to inject DemosContract and other dependencies
        const wrappedSource = `
            (function(DemosContract, console, Object, Array, String, Number, Boolean, Date, Math, JSON, BigInt, Map, Set, Promise, Error, TypeError, RangeError, SyntaxError) {
                ${source}
                
                // Find and return the contract class
                // Look for a class that extends DemosContract
                const exports = {};
                eval(\`\${source}\`);
                
                // Try to find exported contract or first class extending DemosContract
                for (let key of Object.keys(this)) {
                    const value = this[key];
                    if (typeof value === 'function') {
                        try {
                            const testInstance = new value();
                            if (testInstance instanceof DemosContract) {
                                return value;
                            }
                        } catch (e) {
                            // Not a valid constructor or requires arguments
                        }
                    }
                }
                
                // Try parsing for class declaration
                const classMatch = source.match(/class\\s+(\\w+)\\s+extends\\s+DemosContract/);
                if (classMatch && classMatch[1]) {
                    return eval(classMatch[1]);
                }
                
                throw new Error("No contract class found that extends DemosContract");
            })
        `

        // 3. Evaluate contract source safely
        console.log("[SandboxExecutor] Evaluating contract source code")
        const contractClassFactory = eval(wrappedSource)
        const ContractClass = contractClassFactory.call(
            {},
            safeGlobals.DemosContract,
            safeGlobals.console,
            safeGlobals.Object,
            safeGlobals.Array,
            safeGlobals.String,
            safeGlobals.Number,
            safeGlobals.Boolean,
            safeGlobals.Date,
            safeGlobals.Math,
            safeGlobals.JSON,
            safeGlobals.BigInt,
            safeGlobals.Map,
            safeGlobals.Set,
            safeGlobals.Promise,
            safeGlobals.Error,
            safeGlobals.TypeError,
            safeGlobals.RangeError,
            safeGlobals.SyntaxError,
        )

        if (!ContractClass) {
            throw new Error("Contract evaluation returned null/undefined")
        }

        // 4. Create contract instance
        console.log("[SandboxExecutor] Creating contract instance")
        const instance = new ContractClass()

        if (!(instance instanceof DemosContract)) {
            throw new Error("Contract must extend DemosContract base class")
        }

        // 5. Initialize contract with execution context and state
        // Use the __initialize method from DemosContract base class
        instance.__initialize(executionContext, contractState)

        // 6. Wrap instance with call counting proxy
        const proxiedInstance = createCallCountingProxy(instance, callCounter)

        console.log(
            "[SandboxExecutor] Contract instance created and initialized",
        )
        return proxiedInstance as DemosContract
    } catch (error) {
        console.error(
            "[SandboxExecutor] Failed to create contract instance:",
            error,
        )
        return null
    }
}

// Handle worker termination
self.onclose = () => {
    console.log("[SandboxExecutor] Worker thread terminated")
}
