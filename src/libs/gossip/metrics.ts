import { getMetricsService } from "src/features/metrics/MetricsService"

let registered = false

export function registerGossipMetrics() {
    if (registered) return
    registered = true
    const m = getMetricsService()
    m.createGauge("gossip_ready", "Gossip layer ready (1) or not (0)", [])
    m.createGauge("gossip_mesh_peers", "Gossipsub subscribers per topic", [
        "topic",
    ])
    m.createHistogram(
        "gossip_block_first_seen_ms",
        "Delay between block timestamp and first local delivery",
        ["source"],
        [100, 250, 500, 1000, 2500, 5000, 10000],
    )
    m.createCounter(
        "gossip_validator_verdicts_total",
        "Topic validator verdicts",
        ["topic", "verdict"],
    )
    m.createCounter(
        "gossip_publish_skipped_total",
        "Publishes skipped because gossip was not ready",
        ["reason"],
    )
    m.createCounter(
        "gossip_heights_records_total",
        "Heights records processed",
        ["result"],
    )
    m.createCounter(
        "gossip_tx_ingest_total",
        "Gossiped transactions handed to the mempool",
        ["result"],
    )
    m.createCounter(
        "gossip_tx_rate_limited_total",
        "Gossiped transactions dropped by rate limiting",
        ["reason"],
    )
}

export function recordVerdict(
    topic: "heights" | "blocks" | "txs",
    verdict: "accept" | "reject" | "ignore",
) {
    try {
        getMetricsService().incrementCounter("gossip_validator_verdicts_total", {
            topic,
            verdict,
        })
    } catch {
        // metrics must never break the message path
    }
}

export function setReadyGauge(ready: boolean) {
    try {
        getMetricsService().setGauge("gossip_ready", ready ? 1 : 0)
    } catch {
        /* ignore */
    }
}

export function setMeshPeersGauge(topic: string, count: number) {
    try {
        getMetricsService().setGauge("gossip_mesh_peers", count, { topic })
    } catch {
        /* ignore */
    }
}

export function countPublishSkipped(reason: string) {
    try {
        getMetricsService().incrementCounter("gossip_publish_skipped_total", {
            reason,
        })
    } catch {
        /* ignore */
    }
}

export function countHeightsRecord(result: string) {
    try {
        getMetricsService().incrementCounter("gossip_heights_records_total", {
            result,
        })
    } catch {
        /* ignore */
    }
}

export function observeBlockFirstSeen(source: "gossip" | "http", delayMs: number) {
    try {
        getMetricsService().observeHistogram(
            "gossip_block_first_seen_ms",
            delayMs,
            { source },
        )
    } catch {
        /* ignore */
    }
}

export function countTxIngest(result: string) {
    try {
        getMetricsService().incrementCounter("gossip_tx_ingest_total", {
            result,
        })
    } catch {
        /* ignore */
    }
}

export function countTxRateLimited(reason: string) {
    try {
        getMetricsService().incrementCounter("gossip_tx_rate_limited_total", {
            reason,
        })
    } catch {
        /* ignore */
    }
}
