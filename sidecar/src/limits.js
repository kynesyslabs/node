// Per-topic message size bounds, applied before a message is relayed or
// published. The values are the parent's (src/libs/gossip/topics.ts), handed
// over in GOSSIP_TOPIC_MAX_BYTES: the sidecar defines no bound of its own, so
// it cannot drift from what the parent's validators enforce after delivery.

/**
 * The bound for each of `topics`, read from the JSON the parent passes.
 * Throws when a topic has no usable bound: relaying without one is what this
 * exists to prevent.
 */
export function parseTopicLimits(raw, topics) {
    let parsed
    try {
        parsed = JSON.parse(raw ?? "")
    } catch {
        throw new Error("GOSSIP_TOPIC_MAX_BYTES is missing or not JSON")
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new Error("GOSSIP_TOPIC_MAX_BYTES is not an object")
    }
    const limits = new Map()
    for (const topic of topics) {
        const max = Object.hasOwn(parsed, topic) ? parsed[topic] : undefined
        if (!Number.isSafeInteger(max) || max <= 0) {
            throw new Error(
                `GOSSIP_TOPIC_MAX_BYTES has no valid bound for ${topic}`,
            )
        }
        limits.set(topic, max)
    }
    return limits
}

/** Whether a message of `byteLength` fits its topic. A topic without a bound never does. */
export function withinTopicLimit(limits, topic, byteLength) {
    const max = limits.get(topic)
    return max !== undefined && byteLength <= max
}

/**
 * Gossipsub topic validator: "reject" for an oversized message, the same
 * verdict the parent's validators give it, so it is not forwarded.
 */
export function sizeValidator(limits, onOversized) {
    return (_peer, msg) => {
        const length = msg?.data?.length ?? 0
        if (withinTopicLimit(limits, msg?.topic, length)) return "accept"
        onOversized?.(msg?.topic, length)
        return "reject"
    }
}
