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

export const scriptExecutor: ScriptExecutor = {
    async executeView() {
        return {
            success: false,
            error: "SCRIPTING_NOT_IMPLEMENTED",
            errorType: "not_implemented",
            executionTimeMs: 0,
            gasUsed: 0,
        }
    },
    async executeMethod() {
        return { success: false, error: "SCRIPTING_NOT_IMPLEMENTED" }
    },
    async executeWithHooks(req) {
        return {
            finalState: req.tokenData,
            mutations: [],
            rejection: { hookType: "engine", reason: "SCRIPTING_NOT_IMPLEMENTED" },
            metadata: { beforeHookExecuted: false, afterHookExecuted: false },
        }
    },
}

export class HookExecutor {
    constructor(private readonly executor: ScriptExecutor) {}

    async executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult> {
        return await this.executor.executeWithHooks(req)
    }
}

