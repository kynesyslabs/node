import { performance } from "node:perf_hooks"
import {
    admitSyncAggregate,
    buildSyncAggregate,
    estimatePostBlockTraffic,
    type BlockSyncAggregateV1,
    type SyncAggregateBlockView,
} from "../../../src/libs/communications/syncAggregation"

interface EmulatorConfig {
    nodeCounts: number[]
    iterations: number
    signerCount: number
    baseLatencyMs: number
    jitterMs: number
    slowPeerRate: number
    slowPeerExtraMs: number
    transientFailureRate: number
    maxAttempts: number
    requestTimeoutMs: number
}

interface ActiveRound {
    block: SyncAggregateBlockView
    identities: string[]
    secretary: string
    config: EmulatorConfig
}

interface AttemptResult {
    ok: boolean
    attempts: number
    elapsedMs: number
    requestBytes: number
    responseBytes: number
    body: unknown
}

interface IterationResult {
    nodeCount: number
    blockNumber: number
    aggregateIdentities: number
    aggregateBytes: number
    blockDeliverySuccesses: number
    aggregateDeliverySuccesses: number
    logicalCalls: number
    httpAttempts: number
    retryAttempts: number
    wireBytes: number
    elapsedMs: number
    blockPhaseMs: number
    aggregatePhaseMs: number
    requestLatenciesMs: number[]
}

interface ScenarioResult {
    nodeCount: number
    signerCount: number
    iterations: number
    legacyCallsPerBlock: number
    aggregateCallsPerBlock: number
    modeledReductionPercent: number
    observedLogicalCallsPerBlock: number
    observedHttpAttemptsPerBlock: number
    observedRetryAttempts: number
    aggregateBytes: number
    wireBytesPerBlock: number
    elapsedMs: {
        mean: number
        p50: number
        p95: number
        p99: number
        max: number
    }
    requestLatencyMs: {
        p50: number
        p95: number
        p99: number
        max: number
    }
    cpuMs: number
    rssPeakBytes: number
    eventLoopDelayMs: {
        mean: number
        p95: number
        p99: number
        max: number
    }
    allDeliveriesAdmitted: boolean
}

const encoder = new TextEncoder()
let activeRound: ActiveRound | null = null

function numericArgument(name: string, fallback: number): number {
    const prefix = `--${name}=`
    const raw = process.argv
        .find(value => value.startsWith(prefix))
        ?.slice(prefix.length)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --${name}`)
    }
    return parsed
}

function parseConfig(): EmulatorConfig {
    const rawCounts =
        process.argv
            .find(value => value.startsWith("--nodes="))
            ?.slice("--nodes=".length) ?? "100,250,500"
    const nodeCounts = rawCounts.split(",").map(value => Number(value))
    if (
        nodeCounts.length === 0 ||
        nodeCounts.some(
            value => !Number.isSafeInteger(value) || value < 5 || value > 1000,
        )
    ) {
        throw new Error("--nodes must contain integers between 5 and 1000")
    }

    return {
        nodeCounts,
        iterations: numericArgument("iterations", 5),
        signerCount: numericArgument("signers", 4),
        baseLatencyMs: numericArgument("base-latency-ms", 20),
        jitterMs: numericArgument("jitter-ms", 80),
        slowPeerRate: numericArgument("slow-peer-rate", 0.05),
        slowPeerExtraMs: numericArgument("slow-peer-extra-ms", 220),
        transientFailureRate: numericArgument("transient-failure-rate", 0.05),
        maxAttempts: numericArgument("max-attempts", 3),
        requestTimeoutMs: numericArgument("request-timeout-ms", 1500),
    }
}

function peerIdentity(index: number): string {
    return `0x${index.toString(16).padStart(64, "0")}`
}

function deterministicUnit(
    peerIndex: number,
    blockNumber: number,
    phase: number,
): number {
    let value =
        Math.imul(peerIndex + 1, 0x45d9f3b) ^
        Math.imul(blockNumber + 17, 0x119de1f3) ^
        Math.imul(phase + 31, 0x3449f)
    value ^= value >>> 16
    return (value >>> 0) / 0x1_0000_0000
}

function peerDelayMs(
    peerIndex: number,
    blockNumber: number,
    phase: number,
    config: EmulatorConfig,
): number {
    const jitterUnit = deterministicUnit(peerIndex, blockNumber, phase)
    const slowUnit = deterministicUnit(peerIndex, blockNumber, phase + 100)
    return (
        config.baseLatencyMs +
        Math.floor(jitterUnit * config.jitterMs) +
        (slowUnit < config.slowPeerRate ? config.slowPeerExtraMs : 0)
    )
}

function shouldFailFirstAttempt(
    peerIndex: number,
    blockNumber: number,
    phase: number,
    config: EmulatorConfig,
): boolean {
    return (
        deterministicUnit(peerIndex, blockNumber, phase + 200) <
        config.transientFailureRate
    )
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    })
}

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
        const round = activeRound
        if (!round) return json({ error: "round-not-active" }, 503)

        const url = new URL(request.url)
        const match = url.pathname.match(/^\/(block|aggregate)\/(\d+)\/(\d+)$/)
        if (!match) return json({ error: "not-found" }, 404)

        const phaseName = match[1]
        const peerIndex = Number(match[2])
        const attempt = Number(match[3])
        if (
            !Number.isSafeInteger(peerIndex) ||
            peerIndex < 0 ||
            peerIndex >= round.identities.length
        ) {
            return json({ error: "unknown-peer" }, 404)
        }

        const phase = phaseName === "block" ? 1 : 2
        if (
            attempt === 0 &&
            shouldFailFirstAttempt(
                peerIndex,
                round.block.number,
                phase,
                round.config,
            )
        ) {
            return json({ error: "simulated-transient-failure" }, 503)
        }

        await Bun.sleep(
            peerDelayMs(peerIndex, round.block.number, phase, round.config),
        )

        if (phaseName === "block") {
            return json({
                result: 200,
                response: {
                    syncData: `1:${round.block.number}:${round.block.hash}`,
                },
            })
        }

        const payload = (await request.json()) as {
            aggregate?: BlockSyncAggregateV1
        }
        const admission = admitSyncAggregate(
            payload.aggregate,
            round.block,
            round.secretary,
            round.identities[peerIndex],
            round.identities,
        )
        if (!admission.ok) {
            return json(
                { result: admission.status, message: admission.message },
                admission.status,
            )
        }
        return json({
            result: 200,
            accepted: admission.acceptedPeerIds.length,
        })
    },
})

function bodyBytes(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength
}

async function postWithRetry(
    pathForAttempt: (attempt: number) => string,
    body: unknown,
    config: EmulatorConfig,
): Promise<AttemptResult> {
    const started = performance.now()
    const requestBody = JSON.stringify(body)
    const requestBytes = encoder.encode(requestBody).byteLength
    let responseBytes = 0
    let parsed: unknown = null

    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
        try {
            const response = await fetch(
                `http://127.0.0.1:${server.port}${pathForAttempt(attempt)}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: requestBody,
                    signal: AbortSignal.timeout(config.requestTimeoutMs),
                },
            )
            const raw = await response.text()
            responseBytes += encoder.encode(raw).byteLength
            parsed = raw ? JSON.parse(raw) : null
            if (response.ok) {
                return {
                    ok: true,
                    attempts: attempt + 1,
                    elapsedMs: performance.now() - started,
                    requestBytes: requestBytes * (attempt + 1),
                    responseBytes,
                    body: parsed,
                }
            }
        } catch {
            parsed = null
        }
    }

    return {
        ok: false,
        attempts: config.maxAttempts,
        elapsedMs: performance.now() - started,
        requestBytes: requestBytes * config.maxAttempts,
        responseBytes,
        body: parsed,
    }
}

function percentile(values: number[], quantile: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(quantile * sorted.length) - 1),
    )
    return sorted[index]
}

function rounded(value: number): number {
    return Number(value.toFixed(3))
}

async function runIteration(
    nodeCount: number,
    blockNumber: number,
    config: EmulatorConfig,
): Promise<IterationResult> {
    const identities = Array.from({ length: nodeCount }, (_, index) =>
        peerIdentity(index),
    )
    const signers = identities.slice(0, config.signerCount)
    const secretary = signers[0]
    const block: SyncAggregateBlockView = {
        number: blockNumber,
        hash: `block-${nodeCount}-${blockNumber}`,
        validation_data: {
            signatures: Object.fromEntries(
                signers.map(identity => [identity, "signature"]),
            ),
        },
        content: { peerlist: identities },
    }
    activeRound = { block, identities, secretary, config }

    const started = performance.now()
    const blockStarted = performance.now()
    const blockBody = { blockNumber: block.number, blockHash: block.hash }
    const blockResults = await Promise.all(
        identities.slice(config.signerCount).map((identity, offset) => {
            const peerIndex = offset + config.signerCount
            return postWithRetry(
                attempt => `/block/${peerIndex}/${attempt}`,
                blockBody,
                config,
            ).then(result => ({ identity, result }))
        }),
    )
    const blockPhaseMs = performance.now() - blockStarted

    const responses = blockResults
        .filter(entry => entry.result.ok)
        .map(entry => ({
            pubkey: entry.identity,
            result: entry.result.body as {
                result: number
                response?: unknown
            },
        }))
    const aggregate = buildSyncAggregate(
        { number: block.number, hash: block.hash },
        secretary,
        responses,
    )

    const aggregateStarted = performance.now()
    const aggregateBody = { aggregate }
    const aggregateResults = await Promise.all(
        identities.slice(1).map((_, offset) => {
            const peerIndex = offset + 1
            return postWithRetry(
                attempt => `/aggregate/${peerIndex}/${attempt}`,
                aggregateBody,
                config,
            )
        }),
    )
    const aggregatePhaseMs = performance.now() - aggregateStarted
    activeRound = null

    const allResults = [
        ...blockResults.map(entry => entry.result),
        ...aggregateResults,
    ]
    return {
        nodeCount,
        blockNumber,
        aggregateIdentities: aggregate.syncedPeerIds.length,
        aggregateBytes: bodyBytes(aggregate),
        blockDeliverySuccesses: blockResults.filter(entry => entry.result.ok)
            .length,
        aggregateDeliverySuccesses: aggregateResults.filter(result => result.ok)
            .length,
        logicalCalls: allResults.length,
        httpAttempts: allResults.reduce(
            (total, result) => total + result.attempts,
            0,
        ),
        retryAttempts: allResults.reduce(
            (total, result) => total + result.attempts - 1,
            0,
        ),
        wireBytes: allResults.reduce(
            (total, result) =>
                total + result.requestBytes + result.responseBytes,
            0,
        ),
        elapsedMs: performance.now() - started,
        blockPhaseMs,
        aggregatePhaseMs,
        requestLatenciesMs: allResults.map(result => result.elapsedMs),
    }
}

async function runScenario(
    nodeCount: number,
    config: EmulatorConfig,
): Promise<ScenarioResult> {
    const eventLoopDelaysMs: number[] = []
    let expectedSampleAt = performance.now() + 10
    const eventLoopSampler = setInterval(() => {
        const now = performance.now()
        eventLoopDelaysMs.push(Math.max(0, now - expectedSampleAt))
        expectedSampleAt = now + 10
    }, 10)
    const cpuBefore = process.cpuUsage()
    let rssPeakBytes = process.memoryUsage().rss
    const rssSampler = setInterval(() => {
        rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss)
    }, 20)

    const iterations: IterationResult[] = []
    for (let index = 0; index < config.iterations; index++) {
        const result = await runIteration(
            nodeCount,
            nodeCount * 10_000 + index,
            config,
        )
        iterations.push(result)
        console.error(
            `sync-scale nodes=${nodeCount} iteration=${index + 1}/${config.iterations} elapsed_ms=${rounded(result.elapsedMs)} attempts=${result.httpAttempts}`,
        )
    }

    clearInterval(rssSampler)
    clearInterval(eventLoopSampler)
    const cpu = process.cpuUsage(cpuBefore)
    const legacy = estimatePostBlockTraffic(
        nodeCount,
        config.signerCount,
        false,
    )
    const aggregate = estimatePostBlockTraffic(
        nodeCount,
        config.signerCount,
        true,
    )
    const elapsed = iterations.map(result => result.elapsedMs)
    const requestLatencies = iterations.flatMap(
        result => result.requestLatenciesMs,
    )
    const logicalCalls = iterations.reduce(
        (total, result) => total + result.logicalCalls,
        0,
    )
    const attempts = iterations.reduce(
        (total, result) => total + result.httpAttempts,
        0,
    )

    return {
        nodeCount,
        signerCount: config.signerCount,
        iterations: config.iterations,
        legacyCallsPerBlock: legacy.totalRequests,
        aggregateCallsPerBlock: aggregate.totalRequests,
        modeledReductionPercent: rounded(
            ((legacy.totalRequests - aggregate.totalRequests) /
                legacy.totalRequests) *
                100,
        ),
        observedLogicalCallsPerBlock: rounded(logicalCalls / config.iterations),
        observedHttpAttemptsPerBlock: rounded(attempts / config.iterations),
        observedRetryAttempts: attempts - logicalCalls,
        aggregateBytes: Math.max(
            ...iterations.map(result => result.aggregateBytes),
        ),
        wireBytesPerBlock: rounded(
            iterations.reduce((total, result) => total + result.wireBytes, 0) /
                config.iterations,
        ),
        elapsedMs: {
            mean: rounded(
                elapsed.reduce((total, value) => total + value, 0) /
                    elapsed.length,
            ),
            p50: rounded(percentile(elapsed, 0.5)),
            p95: rounded(percentile(elapsed, 0.95)),
            p99: rounded(percentile(elapsed, 0.99)),
            max: rounded(Math.max(...elapsed)),
        },
        requestLatencyMs: {
            p50: rounded(percentile(requestLatencies, 0.5)),
            p95: rounded(percentile(requestLatencies, 0.95)),
            p99: rounded(percentile(requestLatencies, 0.99)),
            max: rounded(Math.max(...requestLatencies)),
        },
        cpuMs: rounded((cpu.user + cpu.system) / 1000),
        rssPeakBytes,
        eventLoopDelayMs: {
            mean: rounded(
                eventLoopDelaysMs.reduce((total, value) => total + value, 0) /
                    Math.max(1, eventLoopDelaysMs.length),
            ),
            p95: rounded(percentile(eventLoopDelaysMs, 0.95)),
            p99: rounded(percentile(eventLoopDelaysMs, 0.99)),
            max: rounded(Math.max(0, ...eventLoopDelaysMs)),
        },
        allDeliveriesAdmitted: iterations.every(
            result =>
                result.blockDeliverySuccesses ===
                    nodeCount - config.signerCount &&
                result.aggregateDeliverySuccesses === nodeCount - 1 &&
                result.aggregateIdentities ===
                    nodeCount - config.signerCount + 1,
        ),
    }
}

function validateSafetyCases(): Record<string, boolean> {
    const identities = Array.from({ length: 6 }, (_, index) =>
        peerIdentity(index),
    )
    const block: SyncAggregateBlockView = {
        number: 42,
        hash: "block-42",
        validation_data: {
            signatures: Object.fromEntries(
                identities.slice(0, 4).map(identity => [identity, {}]),
            ),
        },
        content: { peerlist: identities },
    }
    const aggregate = buildSyncAggregate(
        block,
        identities[0],
        identities.slice(4).map(pubkey => ({
            pubkey,
            result: {
                result: 200,
                response: { syncData: "1:42:block-42" },
            },
        })),
    )
    const valid = admitSyncAggregate(
        aggregate,
        block,
        identities[0],
        identities[1],
        identities,
    )
    const nonSigner = admitSyncAggregate(
        aggregate,
        block,
        identities[5],
        identities[1],
        identities,
    )
    const wrongBlock = admitSyncAggregate(
        aggregate,
        { ...block, hash: "wrong-block" },
        identities[0],
        identities[1],
        identities,
    )
    return {
        validAggregateAccepted: valid.ok,
        nonSignerRejected:
            !nonSigner.ok && "status" in nonSigner && nonSigner.status === 403,
        wrongBlockRejected:
            !wrongBlock.ok &&
            "status" in wrongBlock &&
            wrongBlock.status === 400,
    }
}

async function main(): Promise<void> {
    const config = parseConfig()
    if (
        !Number.isSafeInteger(config.iterations) ||
        config.iterations < 1 ||
        !Number.isSafeInteger(config.signerCount) ||
        config.signerCount < 1 ||
        config.slowPeerRate > 1 ||
        config.transientFailureRate > 1
    ) {
        throw new Error("Invalid emulator configuration")
    }

    const results: ScenarioResult[] = []
    for (const nodeCount of config.nodeCounts) {
        if (config.signerCount >= nodeCount) {
            throw new Error("signer count must be smaller than node count")
        }
        results.push(await runScenario(nodeCount, config))
    }

    const safety = validateSafetyCases()
    const passed =
        results.every(
            result =>
                result.allDeliveriesAdmitted &&
                result.observedLogicalCallsPerBlock ===
                    result.aggregateCallsPerBlock,
        ) && Object.values(safety).every(Boolean)

    // eslint-disable-next-line no-console -- stdout is the machine-readable report.
    console.log(
        JSON.stringify(
            {
                kind: "block-sync-scale-emulator-v1",
                generatedAt: new Date().toISOString(),
                config,
                safety,
                results,
                passed,
            },
            null,
            2,
        ),
    )
    if (!passed) process.exitCode = 1
}

try {
    await main()
} finally {
    activeRound = null
    server.stop(true)
}
