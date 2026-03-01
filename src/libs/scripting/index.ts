export type GCRTokenData = {
    address: string
    name: string
    ticker: string
    decimals: number
    owner: string
    totalSupply: bigint
    balances: Record<string, bigint>
    allowances: Record<string, Record<string, bigint>>
    paused: boolean
    storage: any
}

export type TokenMutation =
    | { kind: "transfer"; from: string; to: string; amount: bigint }
    | { kind: "mint"; to: string; amount: bigint }
    | { kind: "burn"; from: string; amount: bigint }

export function createTransferMutations(
    from: string,
    to: string,
    amount: bigint,
): TokenMutation[] {
    return [{ kind: "transfer", from, to, amount }]
}

export function createMintMutations(to: string, amount: bigint): TokenMutation[] {
    return [{ kind: "mint", to, amount }]
}

export function createBurnMutations(
    from: string,
    amount: bigint,
): TokenMutation[] {
    return [{ kind: "burn", from, amount }]
}

export function applyMutations(
    tokenData: GCRTokenData,
    mutations: TokenMutation[],
): { newState: GCRTokenData } {
    const balances: Record<string, bigint> = { ...tokenData.balances }
    let totalSupply = tokenData.totalSupply

    for (const m of mutations) {
        if (m.kind === "transfer") {
            // Self-transfer should be a no-op for balances (prevents accidental minting).
            // If scripts want special behavior, they can return explicit mutations.
            if (m.from?.toLowerCase?.() === m.to?.toLowerCase?.()) continue
            const fromBal = balances[m.from] ?? 0n
            const toBal = balances[m.to] ?? 0n
            balances[m.from] = fromBal - m.amount
            balances[m.to] = toBal + m.amount
            if (balances[m.from] === 0n) delete balances[m.from]
        } else if (m.kind === "mint") {
            const toBal = balances[m.to] ?? 0n
            balances[m.to] = toBal + m.amount
            totalSupply += m.amount
        } else if (m.kind === "burn") {
            const fromBal = balances[m.from] ?? 0n
            balances[m.from] = fromBal - m.amount
            if (balances[m.from] === 0n) delete balances[m.from]
            totalSupply -= m.amount
        }
    }

    return {
        newState: {
            ...tokenData,
            totalSupply,
            balances,
        },
    }
}

export type ExecuteWithHooksRequest = {
    operation: string
    operationData: any
    tokenAddress: string
    tokenData: GCRTokenData
    scriptCode: string
    txContext: {
        caller: string
        txHash: string
        timestamp: number
        blockHeight: number
        prevBlockHash: string
    }
    nativeOperationMutations: TokenMutation[]
}

export type HookExecutionResult = {
    finalState: GCRTokenData
    mutations: TokenMutation[]
    rejection: null | { hookType: string; reason: string }
    metadata: {
        beforeHookExecuted: boolean
        afterHookExecuted: boolean
    }
}

export type ScriptViewRequest = {
    tokenAddress: string
    method: string
    args: any[]
    tokenData: GCRTokenData
    scriptCode: string
}

export type ScriptMethodRequest = {
    tokenAddress: string
    method: string
    args: any[]
    caller: string
    blockContext: { timestamp: number; height: number; prevBlockHash: string }
    txHash: string
    tokenData: GCRTokenData
}

export type ScriptViewResult =
    | {
          success: true
          value: any
          executionTimeMs: number
          gasUsed: number
      }
    | {
          success: false
          error: string
          errorType?: string
          executionTimeMs: number
          gasUsed: number
      }

export type ScriptMethodResult =
    | {
          success: true
          returnValue: any
          mutations: TokenMutation[]
      }
    | { success: false; error: string; errorType?: string }

export type ScriptExecutor = {
    executeView(req: ScriptViewRequest): Promise<ScriptViewResult>
    executeMethod(req: ScriptMethodRequest): Promise<ScriptMethodResult>
    executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult>
}

type CompiledTokenScript = {
    views: Record<string, Function>
    hooks: Record<string, Function>
    methods: Record<string, Function>
}

const compiledCache = new Map<string, CompiledTokenScript>()

function compileScript(scriptCode: string): CompiledTokenScript {
    const cached = compiledCache.get(scriptCode)
    if (cached) return cached

    // Lazy import to keep this module tree simple for Bun bundling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require("vm") as typeof import("vm")

    const module = { exports: {} as any }
    const sandbox = {
        module,
        exports: module.exports,
        BigInt,
    }

    const context = vm.createContext(sandbox, { name: "TokenScript", codeGeneration: { strings: true, wasm: false } })
    const script = new vm.Script(String(scriptCode ?? ""), { filename: "token-script.js" })
    script.runInContext(context, { timeout: 50 })

    const exported = (module.exports ?? sandbox.exports ?? {}) as any

    const compiled: CompiledTokenScript = {
        views: typeof exported.views === "object" && exported.views ? exported.views : {},
        hooks: typeof exported.hooks === "object" && exported.hooks ? exported.hooks : {},
        methods: typeof exported.methods === "object" && exported.methods ? exported.methods : {},
    }

    compiledCache.set(scriptCode, compiled)
    return compiled
}

function hookNameForOperation(operation: string, phase: "before" | "after"): string | null {
    const op = String(operation ?? "").toLowerCase()
    if (op === "transfer") return phase === "before" ? "beforeTransfer" : "afterTransfer"
    if (op === "mint") return phase === "before" ? "beforeMint" : "afterMint"
    if (op === "burn") return phase === "before" ? "beforeBurn" : "afterBurn"
    if (op === "approve") return "onApprove"
    return null
}

export const scriptExecutor: ScriptExecutor = {
    async executeView(req) {
        const started = Date.now()
        try {
            const compiled = compileScript(req.scriptCode)
            const fn = compiled.views?.[req.method]
            if (typeof fn !== "function") {
                return {
                    success: false,
                    error: `Unknown view method: ${req.method}`,
                    errorType: "unknown_method",
                    executionTimeMs: Date.now() - started,
                    gasUsed: 0,
                }
            }

            const value = await fn(req.tokenData, ...(Array.isArray(req.args) ? req.args : []))
            return {
                success: true,
                value,
                executionTimeMs: Date.now() - started,
                gasUsed: 0,
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message ?? String(error),
                errorType: "execution_error",
                executionTimeMs: Date.now() - started,
                gasUsed: 0,
            }
        }
    },
    async executeMethod(req) {
        try {
            // For now: allow custom method execution for scripted tokens using `methods`.
            // This is intentionally minimal; advanced gas/metering can be added later.
            const compiled = compileScript((req as any).scriptCode ?? "")
            const fn = compiled.methods?.[req.method]
            if (typeof fn !== "function") {
                return { success: false, error: `Unknown method: ${req.method}`, errorType: "unknown_method" }
            }
            const returnValue = await fn(req.tokenData, ...(Array.isArray(req.args) ? req.args : []))
            return { success: true, returnValue, mutations: [] }
        } catch (error: any) {
            return { success: false, error: error?.message ?? String(error), errorType: "execution_error" }
        }
    },
    async executeWithHooks(req) {
        const compiled = compileScript(req.scriptCode)

        const beforeName = hookNameForOperation(req.operation, "before")
        const afterName = hookNameForOperation(req.operation, "after")

        let tokenData = req.tokenData
        let mutations: TokenMutation[] = [...(req.nativeOperationMutations ?? [])]
        let beforeHookExecuted = false
        let afterHookExecuted = false

        const runHook = async (name: string) => {
            const hook = compiled.hooks?.[name]
            if (typeof hook !== "function") return null
            const ctx = {
                operation: req.operation,
                operationData: req.operationData,
                tokenAddress: req.tokenAddress,
                token: tokenData,
                txContext: req.txContext,
                mutations,
            }
            const out = await hook(ctx)
            return out ?? null
        }

        try {
            if (beforeName) {
                const beforeOut = await runHook(beforeName)
                if (beforeOut) {
                    beforeHookExecuted = true
                    if (beforeOut.reject) {
                        return {
                            finalState: tokenData,
                            mutations: [],
                            rejection: { hookType: beforeName, reason: String(beforeOut.reject) },
                            metadata: { beforeHookExecuted, afterHookExecuted },
                        }
                    }
                    if (Array.isArray(beforeOut.mutations)) mutations = beforeOut.mutations
                    if (beforeOut.setStorage !== undefined) tokenData = { ...tokenData, storage: beforeOut.setStorage }
                }
            }

            const applied = applyMutations(tokenData, mutations)
            tokenData = applied.newState

            if (afterName) {
                const afterOut = await runHook(afterName)
                if (afterOut) {
                    afterHookExecuted = true
                    if (afterOut.reject) {
                        return {
                            finalState: tokenData,
                            mutations,
                            rejection: { hookType: afterName, reason: String(afterOut.reject) },
                            metadata: { beforeHookExecuted, afterHookExecuted },
                        }
                    }
                    if (Array.isArray(afterOut.mutations)) {
                        const appliedAfter = applyMutations(tokenData, afterOut.mutations)
                        tokenData = appliedAfter.newState
                        mutations = [...mutations, ...afterOut.mutations]
                    }
                    if (afterOut.setStorage !== undefined) tokenData = { ...tokenData, storage: afterOut.setStorage }
                }
            }

            return {
                finalState: tokenData,
                mutations,
                rejection: null,
                metadata: { beforeHookExecuted, afterHookExecuted },
            }
        } catch (error: any) {
            return {
                finalState: req.tokenData,
                mutations: [],
                rejection: { hookType: "engine", reason: error?.message ?? String(error) },
                metadata: { beforeHookExecuted, afterHookExecuted },
            }
        }
    },
}

export class HookExecutor {
    constructor(private readonly executor: ScriptExecutor) {}

    async executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult> {
        return await this.executor.executeWithHooks(req)
    }
}
