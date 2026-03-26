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

function parseDecimalBigInt(value: string): bigint {
    const trimmed = value.trim()
    if (/^[+-]?\d+$/.test(trimmed)) return BigInt(trimmed)

    const match = trimmed.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/)
    if (!match) throw new SyntaxError("Failed to parse String to BigInt")

    const [, sign, intPart, fracPartRaw = "", exponentRaw] = match
    const exponent = Number.parseInt(exponentRaw, 10)
    if (!Number.isFinite(exponent)) throw new SyntaxError("Failed to parse String to BigInt")

    const digits = `${intPart}${fracPartRaw}`.replace(/^0+/, "") || "0"
    const scale = fracPartRaw.length
    const shift = exponent - scale
    if (shift < 0) {
        const fractional = digits.slice(digits.length + shift)
        if (fractional && /[1-9]/.test(fractional)) {
            throw new SyntaxError("Failed to parse String to BigInt")
        }
        const wholeDigits = digits.slice(0, digits.length + shift) || "0"
        return BigInt(`${sign}${wholeDigits}`)
    }
    return BigInt(`${sign}${digits}${"0".repeat(shift)}`)
}

function coerceBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value
    if (typeof value === "number") {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
            throw new TypeError("Invalid numeric mutation amount")
        }
        return parseDecimalBigInt(value.toString())
    }
    if (typeof value === "string") return parseDecimalBigInt(value)
    if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as any).$demos_bigint_v1 === "string"
    ) {
        return parseDecimalBigInt((value as any).$demos_bigint_v1)
    }
    throw new TypeError("Invalid bigint-like value")
}

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
    const balances: Record<string, bigint> = Object.fromEntries(
        Object.entries(tokenData.balances ?? {}).map(([addr, balance]) => [addr, coerceBigInt(balance)]),
    )
    let totalSupply = coerceBigInt(tokenData.totalSupply)

    for (const m of mutations) {
        if (!m || typeof m !== "object") {
            throw new Error("Invalid mutation: not an object")
        }

        if (m.kind === "transfer") {
            const amount = coerceBigInt(m.amount)
            if (amount <= 0n) throw new Error(`Invalid transfer amount: ${amount}`)
            // Self-transfer should be a no-op for balances (prevents accidental minting).
            // If scripts want special behavior, they can return explicit mutations.
            if (m.from?.toLowerCase?.() === m.to?.toLowerCase?.()) continue
            const fromBal = coerceBigInt(balances[m.from] ?? 0n)
            const toBal = coerceBigInt(balances[m.to] ?? 0n)
            if (fromBal < amount) {
                throw new Error(`Insufficient balance for transfer: from=${m.from} have=${fromBal} need=${amount}`)
            }
            balances[m.from] = fromBal - amount
            balances[m.to] = toBal + amount
            if (balances[m.from] === 0n) delete balances[m.from]
        } else if (m.kind === "mint") {
            const amount = coerceBigInt(m.amount)
            if (amount <= 0n) throw new Error(`Invalid mint amount: ${amount}`)
            const toBal = coerceBigInt(balances[m.to] ?? 0n)
            balances[m.to] = toBal + amount
            totalSupply += amount
        } else if (m.kind === "burn") {
            const amount = coerceBigInt(m.amount)
            if (amount <= 0n) throw new Error(`Invalid burn amount: ${amount}`)
            const fromBal = coerceBigInt(balances[m.from] ?? 0n)
            if (fromBal < amount) {
                throw new Error(`Insufficient balance for burn: from=${m.from} have=${fromBal} need=${amount}`)
            }
            if (totalSupply < amount) {
                throw new Error(`Invalid burn exceeds totalSupply: supply=${totalSupply} burn=${amount}`)
            }
            balances[m.from] = fromBal - amount
            if (balances[m.from] === 0n) delete balances[m.from]
            totalSupply -= amount
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
          // Process isolation now requires values to remain JSON-serializable plus bigint-safe.
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
          // Keep method results limited to the same transport-safe value space as views.
          returnValue: any
          mutations: TokenMutation[]
      }
    | { success: false; error: string; errorType?: string }

export type ScriptExecutor = {
    executeView(req: ScriptViewRequest): Promise<ScriptViewResult>
    executeMethod(req: ScriptMethodRequest): Promise<ScriptMethodResult>
    executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult>
}
