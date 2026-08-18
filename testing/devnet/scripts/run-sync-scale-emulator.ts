import { performance } from "node:perf_hooks"
import {
    admitSyncAggregate,
    blockDeliveryPartition,
    buildSyncAggregate,
    buildSyncAggregateV2,
    estimatePostBlockTraffic,
    type BlockSyncAggregate,
    type SyncAggregateBlockView,
} from "../../../src/libs/communications/syncAggregation"

interface EmulatorConfig {
    nodeCounts: number[]
    iterations: number
    aggregateVersion: 1 | 2
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
    /** Successful /block deliveries per peer index (v2 exactly-once check). */
    blockDeliveredCounts: number[]
    /** Per receiving peer, union of acceptedPeerIds across admitted partials. */
    acceptedUnions: Set<string>[]
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
    /** v2 only: v1 aggregate size for the same responses as the partial. */
    v1AggregateBytes?: number
    /** v2 only: every non-signer received the block exactly once. */
    blockDeliveredExactlyOnce?: boolean
    /** v2 only: every partial was admitted (HTTP ok + result 200) everywhere. */
    allPartialsAdmitted?: boolean
    /** v2 only: every receiver's accepted union is all identities but itself. */
    coverageExact?: boolean
}

interface ScenarioResult {
    nodeCount: number
    signerCount: number
    iterations: number
    aggregateVersion: 1 | 2
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
    coverageExact: boolean
    v1VsV2AggregateBytes: {
        v1AggregateBytes: number | null
        v2PartialAggregateBytes: number | null
    }
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

function parseAggregateVersion(): 1 | 2 {
    const raw =
        process.argv
            .find(value => value.startsWith("--aggregate-version="))
            ?.slice("--aggregate-version=".length) ??
        process.env.AGGREGATE_VERSION ??
        "2"
    const parsed = Number(raw)
    if (parsed !== 1 && parsed !== 2) {
        throw new Error("--aggregate-version must be 1 or 2")
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
        aggregateVersion: parseAggregateVersion(),
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
            round.blockDeliveredCounts[peerIndex] += 1
            return json({
                result: 200,
                response: {
                    syncData: `1:${round.block.number}:${round.block.hash}`,
                },
            })
        }

        // v2 partials arrive from every committee member; the sender index
        // travels as a query parameter so the handler admits with the real
        // sender identity. Absent (v1 flow), the secretary remains the sender.
        const senderParam = url.searchParams.get("sender")
        let senderIdentity = round.secretary
        if (senderParam !== null) {
            const senderIndex = Number(senderParam)
            if (
                !Number.isSafeInteger(senderIndex) ||
                senderIndex < 0 ||
                senderIndex >= round.identities.length
            ) {
                return json({ error: "unknown-sender" }, 404)
            }
            senderIdentity = round.identities[senderIndex]
        }

        const payload = (await request.json()) as {
            aggregate?: BlockSyncAggregate
        }
        const admission = admitSyncAggregate(
            payload.aggregate,
            round.block,
            senderIdentity,
            round.identities[peerIndex],
            round.identities,
        )
        if (!admission.ok) {
            return json(
                { result: admission.status, message: admission.message },
                admission.status,
            )
        }
        for (const identity of admission.acceptedPeerIds) {
            round.acceptedUnions[peerIndex].add(identity)
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

function makeRoundFixture(
    nodeCount: number,
    blockNumber: number,
    config: EmulatorConfig,
): ActiveRound {
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
    return {
        block,
        identities,
        secretary,
        config,
        blockDeliveredCounts: new Array<number>(nodeCount).fill(0),
        acceptedUnions: identities.map(() => new Set<string>()),
    }
}

async function runIteration(
    nodeCount: number,
    blockNumber: number,
    config: EmulatorConfig,
): Promise<IterationResult> {
    if (config.aggregateVersion === 2) {
        return runIterationV2(nodeCount, blockNumber, config)
    }
    const round = makeRoundFixture(nodeCount, blockNumber, config)
    const { block, identities, secretary } = round
    activeRound = round

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

async function runIterationV2(
    nodeCount: number,
    blockNumber: number,
    config: EmulatorConfig,
): Promise<IterationResult> {
    const round = makeRoundFixture(nodeCount, blockNumber, config)
    const { block, identities } = round
    const signers = identities.slice(0, config.signerCount)
    const nonSigners = identities.slice(config.signerCount)
    const indexOf = new Map(
        identities.map((identity, index) => [identity, index] as const),
    )

    // Every committee member computes its own delivery slice with the real
    // partition function; together the slices must cover every non-signer
    // exactly once.
    const slices = signers.map(member => {
        const slice = blockDeliveryPartition(member, signers, identities)
        if (slice === null) {
            throw new Error(
                `committee member ${member} has no v2 delivery slice`,
            )
        }
        return { member, slice }
    })
    const coveredCounts = new Map<string, number>()
    for (const { slice } of slices) {
        for (const identity of slice) {
            coveredCounts.set(identity, (coveredCounts.get(identity) ?? 0) + 1)
        }
    }
    if (
        coveredCounts.size !== nonSigners.length ||
        nonSigners.some(identity => coveredCounts.get(identity) !== 1)
    ) {
        throw new Error(
            "v2 delivery slices do not cover the non-signers exactly once",
        )
    }

    activeRound = round

    const started = performance.now()
    const blockStarted = performance.now()
    const blockBody = { blockNumber: block.number, blockHash: block.hash }
    const memberDeliveries = await Promise.all(
        slices.map(async ({ member, slice }) => {
            const results = await Promise.all(
                slice.map(identity => {
                    const peerIndex = indexOf.get(identity)
                    if (peerIndex === undefined) {
                        throw new Error(`unknown delivery target ${identity}`)
                    }
                    return postWithRetry(
                        attempt => `/block/${peerIndex}/${attempt}`,
                        blockBody,
                        config,
                    ).then(result => ({ identity, result }))
                }),
            )
            return { member, results }
        }),
    )
    const blockPhaseMs = performance.now() - blockStarted
    const blockResults = memberDeliveries.flatMap(entry => entry.results)

    // One partial bitmap aggregate per committee member, built from that
    // member's own slice responses with the real builder.
    const partials = memberDeliveries.map(({ member, results }) => {
        const responses = results
            .filter(entry => entry.result.ok)
            .map(entry => ({
                pubkey: entry.identity,
                result: entry.result.body as {
                    result: number
                    response?: unknown
                },
            }))
        const partial = buildSyncAggregateV2(
            block as unknown as Parameters<typeof buildSyncAggregateV2>[0],
            member,
            responses,
        )
        if (!partial) {
            throw new Error(
                "buildSyncAggregateV2 returned null for a committed peerlist",
            )
        }
        return { member, responses, partial }
    })
    // v1 aggregate for the same responses, built in memory purely for the
    // byte comparison — never sent.
    const v1Comparison = buildSyncAggregate(
        { number: block.number, hash: block.hash },
        partials[0].member,
        partials[0].responses,
    )

    // Each builder applies its own partial locally (a node never posts to
    // itself), through the real admission path, so its accepted union also
    // carries its own slice.
    for (const { member, partial } of partials) {
        const selfIndex = indexOf.get(member)
        if (selfIndex === undefined) {
            throw new Error(`unknown committee member ${member}`)
        }
        const selfAdmission = admitSyncAggregate(
            partial,
            block,
            member,
            member,
            identities,
        )
        if (!selfAdmission.ok) {
            throw new Error(
                `local self-admission failed for committee member ${member}`,
            )
        }
        for (const identity of selfAdmission.acceptedPeerIds) {
            round.acceptedUnions[selfIndex].add(identity)
        }
    }

    const aggregateStarted = performance.now()
    const aggregateResults = (
        await Promise.all(
            partials.map(({ member, partial }) => {
                const senderIndex = indexOf.get(member)
                if (senderIndex === undefined) {
                    throw new Error(`unknown committee member ${member}`)
                }
                const aggregateBody = { aggregate: partial }
                return Promise.all(
                    identities
                        .map((_, peerIndex) => peerIndex)
                        .filter(peerIndex => peerIndex !== senderIndex)
                        .map(peerIndex =>
                            postWithRetry(
                                attempt =>
                                    `/aggregate/${peerIndex}/${attempt}?sender=${senderIndex}`,
                                aggregateBody,
                                config,
                            ),
                        ),
                )
            }),
        )
    ).flat()
    const aggregatePhaseMs = performance.now() - aggregateStarted
    activeRound = null

    const blockDeliveredExactlyOnce = round.blockDeliveredCounts.every(
        (count, index) => count === (index < config.signerCount ? 0 : 1),
    )
    const allPartialsAdmitted = aggregateResults.every(result => {
        if (!result.ok) return false
        const body = result.body as { result?: unknown } | null
        return body !== null && body?.result === 200
    })
    // Admission excludes the receiver's own identity, so every receiver must
    // end with exactly the committed peerlist minus itself.
    const coverageExact = identities.every((identity, index) => {
        const union = round.acceptedUnions[index]
        return (
            union.size === identities.length - 1 &&
            !union.has(identity) &&
            identities.every(
                other => other === identity || union.has(other),
            )
        )
    })

    const allResults = [
        ...blockResults.map(entry => entry.result),
        ...aggregateResults,
    ]
    return {
        nodeCount,
        blockNumber,
        aggregateIdentities: partials[0].responses.length + 1,
        aggregateBytes: bodyBytes(partials[0].partial),
        v1AggregateBytes: bodyBytes(v1Comparison),
        blockDeliverySuccesses: blockResults.filter(entry => entry.result.ok)
            .length,
        aggregateDeliverySuccesses: aggregateResults.filter(result => result.ok)
            .length,
        blockDeliveredExactlyOnce,
        allPartialsAdmitted,
        coverageExact,
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
        config.aggregateVersion,
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
        aggregateVersion: config.aggregateVersion,
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
        allDeliveriesAdmitted:
            config.aggregateVersion === 2
                ? iterations.every(
                      result =>
                          result.blockDeliverySuccesses ===
                              nodeCount - config.signerCount &&
                          result.aggregateDeliverySuccesses ===
                              config.signerCount * (nodeCount - 1) &&
                          result.blockDeliveredExactlyOnce === true &&
                          result.allPartialsAdmitted === true,
                  )
                : iterations.every(
                      result =>
                          result.blockDeliverySuccesses ===
                              nodeCount - config.signerCount &&
                          result.aggregateDeliverySuccesses ===
                              nodeCount - 1 &&
                          result.aggregateIdentities ===
                              nodeCount - config.signerCount + 1,
                  ),
        coverageExact:
            config.aggregateVersion === 2
                ? iterations.every(result => result.coverageExact === true)
                : true,
        v1VsV2AggregateBytes:
            config.aggregateVersion === 2
                ? {
                      v1AggregateBytes: Math.max(
                          ...iterations.map(
                              result => result.v1AggregateBytes ?? 0,
                          ),
                      ),
                      v2PartialAggregateBytes: Math.max(
                          ...iterations.map(result => result.aggregateBytes),
                      ),
                  }
                : {
                      v1AggregateBytes: Math.max(
                          ...iterations.map(result => result.aggregateBytes),
                      ),
                      v2PartialAggregateBytes: null,
                  },
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
    const v2Responses = identities.slice(4).map(pubkey => ({
        pubkey,
        result: {
            result: 200,
            response: { syncData: "1:42:block-42" },
        },
    }))
    const aggregateV2 = buildSyncAggregateV2(
        block as unknown as Parameters<typeof buildSyncAggregateV2>[0],
        identities[0],
        v2Responses,
    )
    if (!aggregateV2) {
        return { v2AggregateBuilt: false }
    }
    const validV2 = admitSyncAggregate(
        aggregateV2,
        block,
        identities[0],
        identities[1],
        identities,
    )
    const v2NonSigner = admitSyncAggregate(
        aggregateV2,
        block,
        identities[5],
        identities[1],
        identities,
    )
    const v2WrongBlock = admitSyncAggregate(
        aggregateV2,
        { ...block, hash: "wrong-block" },
        identities[0],
        identities[1],
        identities,
    )
    const v2PeerlistMismatch = admitSyncAggregate(
        { ...aggregateV2, peerlistSize: aggregateV2.peerlistSize + 1 },
        block,
        identities[0],
        identities[1],
        identities,
    )
    // Craft a bitmap with a set bit beyond the canonical index: decode the
    // valid ackBits, set a high trailing bit and re-encode.
    const tamperedBytes = Buffer.from(aggregateV2.ackBits, "base64")
    tamperedBytes[tamperedBytes.length - 1] |= 0x80
    const v2TrailingBit = admitSyncAggregate(
        {
            ...aggregateV2,
            ackBits: Buffer.from(tamperedBytes).toString("base64"),
        },
        block,
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
        v2AggregateBuilt: true,
        v2AggregateAccepted: validV2.ok,
        v2NonSignerRejected:
            !v2NonSigner.ok &&
            "status" in v2NonSigner &&
            v2NonSigner.status === 403,
        v2WrongBlockRejected:
            !v2WrongBlock.ok &&
            "status" in v2WrongBlock &&
            v2WrongBlock.status === 400,
        v2PeerlistSizeMismatchRejected:
            !v2PeerlistMismatch.ok &&
            "status" in v2PeerlistMismatch &&
            v2PeerlistMismatch.status === 400,
        v2TrailingBitRejected:
            !v2TrailingBit.ok &&
            "status" in v2TrailingBit &&
            v2TrailingBit.status === 400,
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
                result.coverageExact &&
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
