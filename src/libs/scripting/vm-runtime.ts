import * as vm from "node:vm"

import {
    applyMutations,
    type ExecuteWithHooksRequest,
    type HookExecutionResult,
    type ScriptMethodRequest,
    type ScriptMethodResult,
    type ScriptViewRequest,
    type ScriptViewResult,
    type TokenMutation,
} from "./shared"

type CompiledTokenScript = {
    views: Record<string, Function>
    hooks: Record<string, Function>
    methods: Record<string, Function>
    module: { exports: any }
    sandbox: Record<string, any>
    context: any
}

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

function cloneHookValue<T>(value: T): T {
    if (value === undefined || value === null) return value
    return structuredClone(value)
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
    const key = `__call_${++vmCallSeq}`
    params.compiled.sandbox[key] = { ns: params.namespace, name: params.name, args: params.args }

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
    const module = { exports: {} as any }
    const sandbox = {
        module,
        exports: module.exports,
        BigInt,
    } as Record<string, any>

    const context = vm.createContext(sandbox, { name: "TokenScript", codeGeneration: { strings: false, wasm: false } })

    const harden = new vm.Script(
        `
        try { if (typeof Date !== "undefined") Date.now = () => { throw new Error("Date.now is disabled in token scripts") } } catch {}
        try { if (typeof Math !== "undefined") Math.random = () => { throw new Error("Math.random is disabled in token scripts") } } catch {}
        try { globalThis.process = undefined } catch {}
        try { globalThis.require = undefined } catch {}
        `,
        { filename: "token-script-harden.js" },
    )
    harden.runInContext(context, { timeout: TOKEN_SCRIPT_COMPILE_TIMEOUT_MS })

    const script = new vm.Script(String(scriptCode ?? ""), { filename: "token-script.js" })
    script.runInContext(context, { timeout: TOKEN_SCRIPT_COMPILE_TIMEOUT_MS })

    const exported = (module.exports ?? sandbox.exports ?? {}) as any

    return {
        views: typeof exported.views === "object" && exported.views ? exported.views : {},
        hooks: typeof exported.hooks === "object" && exported.hooks ? exported.hooks : {},
        methods: typeof exported.methods === "object" && exported.methods ? exported.methods : {},
        module,
        sandbox,
        context,
    }
}

function hookNameForOperation(operation: string, phase: "before" | "after"): string | null {
    const op = String(operation ?? "").toLowerCase()
    if (op === "transfer") return phase === "before" ? "beforeTransfer" : "afterTransfer"
    if (op === "mint") return phase === "before" ? "beforeMint" : "afterMint"
    if (op === "burn") return phase === "before" ? "beforeBurn" : "afterBurn"
    if (op === "approve") return phase === "before" ? "onApprove" : null
    return null
}

function normalizeTransportValue<T>(value: T, label: string): T {
    try {
        return JSON.parse(JSON.stringify(value, (_key, current) => {
            if (typeof current === "bigint") {
                return { $demos_bigint_v1: current.toString() }
            }
            return current
        }), (_key, current) => {
            if (
                current &&
                typeof current === "object" &&
                !Array.isArray(current) &&
                typeof current.$demos_bigint_v1 === "string" &&
                Object.keys(current).length === 1
            ) {
                return BigInt(current.$demos_bigint_v1)
            }
            return current
        }) as T
    } catch (error: any) {
        throw new Error(`${label} must be JSON-serializable and bigint-safe across the script worker boundary: ${error?.message ?? String(error)}`)
    }
}

function isTimeoutError(message: string): boolean {
    return message.includes("Script execution timed out") || message.toLowerCase().includes("timed out")
}

export async function executeViewInSandbox(req: ScriptViewRequest): Promise<ScriptViewResult> {
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
            value: normalizeTransportValue(value, `token view ${req.method} return value`),
            executionTimeMs: Date.now() - started,
            gasUsed: 0,
        }
    } catch (error: any) {
        const msg = error?.message ?? String(error)
        return {
            success: false,
            error: msg,
            errorType: isTimeoutError(msg) ? "timeout" : "execution_error",
            executionTimeMs: Date.now() - started,
            gasUsed: 0,
        }
    }
}

export async function executeMethodInSandbox(req: ScriptMethodRequest): Promise<ScriptMethodResult> {
    try {
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
        return {
            success: true,
            returnValue: normalizeTransportValue(returnValue, `token method ${req.method} return value`),
            mutations: [],
        }
    } catch (error: any) {
        const msg = error?.message ?? String(error)
        return {
            success: false,
            error: msg,
            errorType: isTimeoutError(msg) ? "timeout" : "execution_error",
        }
    }
}

export async function executeWithHooksInSandbox(req: ExecuteWithHooksRequest): Promise<HookExecutionResult> {
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
            operationData: cloneHookValue(req.operationData),
            tokenAddress: req.tokenAddress,
            token: cloneHookValue(tokenData),
            txContext: cloneHookValue(req.txContext),
            mutations: cloneHookValue(mutations),
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
}
