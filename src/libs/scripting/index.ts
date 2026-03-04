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
        if (!m || typeof m !== "object") {
            throw new Error("Invalid mutation: not an object")
        }

        if (m.kind === "transfer") {
            if (m.amount <= 0n) throw new Error(`Invalid transfer amount: ${m.amount}`)
            // Self-transfer should be a no-op for balances (prevents accidental minting).
            // If scripts want special behavior, they can return explicit mutations.
            if (m.from?.toLowerCase?.() === m.to?.toLowerCase?.()) continue
            const fromBal = balances[m.from] ?? 0n
            const toBal = balances[m.to] ?? 0n
            if (fromBal < m.amount) {
                throw new Error(`Insufficient balance for transfer: from=${m.from} have=${fromBal} need=${m.amount}`)
            }
            balances[m.from] = fromBal - m.amount
            balances[m.to] = toBal + m.amount
            if (balances[m.from] === 0n) delete balances[m.from]
        } else if (m.kind === "mint") {
            if (m.amount <= 0n) throw new Error(`Invalid mint amount: ${m.amount}`)
            const toBal = balances[m.to] ?? 0n
            balances[m.to] = toBal + m.amount
            totalSupply += m.amount
        } else if (m.kind === "burn") {
            if (m.amount <= 0n) throw new Error(`Invalid burn amount: ${m.amount}`)
            const fromBal = balances[m.from] ?? 0n
            if (fromBal < m.amount) {
                throw new Error(`Insufficient balance for burn: from=${m.from} have=${fromBal} need=${m.amount}`)
            }
            if (totalSupply < m.amount) {
                throw new Error(`Invalid burn exceeds totalSupply: supply=${totalSupply} burn=${m.amount}`)
            }
            balances[m.from] = fromBal - m.amount
            if (balances[m.from] === 0n) delete balances[m.from]
            totalSupply -= m.amount
        } else {
            throw new Error(`Unknown mutation kind: ${(m as any).kind}`)
        }
    }

    if (totalSupply < 0n) throw new Error(`Invalid totalSupply (negative): ${totalSupply}`)

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
    scriptCode: string
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
    module: { exports: any }
    sandbox: Record<string, any>
    context: any
}

const compiledCache = new Map<string, CompiledTokenScript>()

let vmCallSeq = 0

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : fallback
}

const TOKEN_SCRIPT_COMPILE_TIMEOUT_MS = envInt("TOKEN_SCRIPT_COMPILE_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_VIEW_TIMEOUT_MS = envInt("TOKEN_SCRIPT_VIEW_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_HOOK_TIMEOUT_MS = envInt("TOKEN_SCRIPT_HOOK_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_METHOD_TIMEOUT_MS = envInt("TOKEN_SCRIPT_METHOD_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_ASYNC_TIMEOUT_MS = envInt("TOKEN_SCRIPT_ASYNC_TIMEOUT_MS", 2000)

function isThenable(value: any): value is Promise<any> {
    return !!value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function"
}

async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!(timeoutMs > 0)) return await promise
    let timer: any
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function runExportedFunctionInVm(params: {
    compiled: CompiledTokenScript
    namespace: "views" | "hooks" | "methods"
    name: string
    args: any[]
    timeoutMs: number
    filename: string
}): any {
    // Lazy import to keep this module tree simple for Bun bundling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require("vm") as typeof import("vm")

    const key = `__call_${++vmCallSeq}`
    params.compiled.sandbox[key] = { ns: params.namespace, name: params.name, args: params.args }

    // Access the function via module.exports[ns][name] inside the VM context, with a hard timeout.
    const code = `module.exports[${key}.ns][${key}.name](...${key}.args)`
    const script = new vm.Script(code, { filename: params.filename })
    try {
        if (params.timeoutMs > 0) return script.runInContext(params.compiled.context, { timeout: params.timeoutMs })
        return script.runInContext(params.compiled.context)
    } finally {
        delete params.compiled.sandbox[key]
    }
}

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
    } as Record<string, any>

    const context = vm.createContext(sandbox, { name: "TokenScript", codeGeneration: { strings: true, wasm: false } })
    const script = new vm.Script(String(scriptCode ?? ""), { filename: "token-script.js" })
    script.runInContext(context, { timeout: TOKEN_SCRIPT_COMPILE_TIMEOUT_MS })

    const exported = (module.exports ?? sandbox.exports ?? {}) as any

    const compiled: CompiledTokenScript = {
        views: typeof exported.views === "object" && exported.views ? exported.views : {},
        hooks: typeof exported.hooks === "object" && exported.hooks ? exported.hooks : {},
        methods: typeof exported.methods === "object" && exported.methods ? exported.methods : {},
        module,
        sandbox,
        context,
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

            const out = runExportedFunctionInVm({
                compiled,
                namespace: "views",
                name: req.method,
                args: [req.tokenData, ...(Array.isArray(req.args) ? req.args : [])],
                timeoutMs: TOKEN_SCRIPT_VIEW_TIMEOUT_MS,
                filename: `token-view:${req.method}`,
            })
            const value = isThenable(out)
                ? await awaitWithTimeout(out, TOKEN_SCRIPT_ASYNC_TIMEOUT_MS, `token view ${req.method}`)
                : out
            return {
                success: true,
                value,
                executionTimeMs: Date.now() - started,
                gasUsed: 0,
            }
        } catch (error: any) {
            const msg = error?.message ?? String(error)
            return {
                success: false,
                error: msg,
                errorType: msg.includes("Script execution timed out") || msg.toLowerCase().includes("timed out")
                    ? "timeout"
                    : "execution_error",
                executionTimeMs: Date.now() - started,
                gasUsed: 0,
            }
        }
    },
    async executeMethod(req) {
        try {
            // For now: allow custom method execution for scripted tokens using `methods`.
            // This is intentionally minimal; advanced gas/metering can be added later.
            const compiled = compileScript(req.scriptCode ?? "")
            const fn = compiled.methods?.[req.method]
            if (typeof fn !== "function") {
                return { success: false, error: `Unknown method: ${req.method}`, errorType: "unknown_method" }
            }
            const out = runExportedFunctionInVm({
                compiled,
                namespace: "methods",
                name: req.method,
                args: [req.tokenData, ...(Array.isArray(req.args) ? req.args : [])],
                timeoutMs: TOKEN_SCRIPT_METHOD_TIMEOUT_MS,
                filename: `token-method:${req.method}`,
            })
            const returnValue = isThenable(out)
                ? await awaitWithTimeout(out, TOKEN_SCRIPT_ASYNC_TIMEOUT_MS, `token method ${req.method}`)
                : out
            return { success: true, returnValue, mutations: [] }
        } catch (error: any) {
            const msg = error?.message ?? String(error)
            return {
                success: false,
                error: msg,
                errorType: msg.includes("Script execution timed out") || msg.toLowerCase().includes("timed out")
                    ? "timeout"
                    : "execution_error",
            }
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
            const out = runExportedFunctionInVm({
                compiled,
                namespace: "hooks",
                name,
                args: [ctx],
                timeoutMs: TOKEN_SCRIPT_HOOK_TIMEOUT_MS,
                filename: `token-hook:${name}`,
            })
            const value = isThenable(out)
                ? await awaitWithTimeout(out, TOKEN_SCRIPT_ASYNC_TIMEOUT_MS, `token hook ${name}`)
                : out
            return value ?? null
        }

        try {
            if (beforeName) {
                let beforeOut: any
                try {
                    beforeOut = await runHook(beforeName)
                } catch (error: any) {
                    const msg = error?.message ?? String(error)
                    return {
                        finalState: tokenData,
                        mutations: [],
                        rejection: { hookType: beforeName, reason: msg },
                        metadata: { beforeHookExecuted, afterHookExecuted },
                    }
                }
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
                let afterOut: any
                try {
                    afterOut = await runHook(afterName)
                } catch (error: any) {
                    const msg = error?.message ?? String(error)
                    return {
                        finalState: tokenData,
                        mutations,
                        rejection: { hookType: afterName, reason: msg },
                        metadata: { beforeHookExecuted, afterHookExecuted },
                    }
                }
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
