/**
 * The sidecar refuses an oversized message before relaying it, using the
 * bounds the parent's validators already enforce (./topics) and none of its
 * own. Only the pure limit module is loaded; no libp2p host is started.
 */

import { describe, expect, it, jest } from "bun:test"
import path from "node:path"

import {
    BLOCKS_MAX_BYTES,
    BLOCKS_TOPIC,
    HEIGHTS_MAX_BYTES,
    HEIGHTS_TOPIC,
    TOPIC_MAX_BYTES,
    TXS_MAX_BYTES,
    TXS_TOPIC,
} from "./topics"

const limitsPath = path.resolve(import.meta.dir, "../../../sidecar/src/limits.js")
const { parseTopicLimits, sizeValidator, topicValidatorsFor, withinTopicLimit } =
    await import(limitsPath)
const blockPolicyPath = path.resolve(import.meta.dir, "../../../sidecar/src/blockPolicy.js")
const { BlockPolicy, BLOCKS_TOPIC: SIDECAR_BLOCKS_TOPIC } = await import(blockPolicyPath)

const TOPICS = [HEIGHTS_TOPIC, BLOCKS_TOPIC, TXS_TOPIC]
/** What GossipManager puts in the sidecar's environment. */
const handedOver = JSON.stringify(TOPIC_MAX_BYTES)

describe("sidecar topic size bounds", () => {
    it("are exactly the parent's bounds, one per topic", () => {
        const limits = parseTopicLimits(handedOver, TOPICS)
        expect([...limits.entries()].sort()).toEqual(
            [
                [BLOCKS_TOPIC, BLOCKS_MAX_BYTES],
                [HEIGHTS_TOPIC, HEIGHTS_MAX_BYTES],
                [TXS_TOPIC, TXS_MAX_BYTES],
            ].sort(),
        )
    })

    it.each([
        [HEIGHTS_TOPIC, HEIGHTS_MAX_BYTES],
        [BLOCKS_TOPIC, BLOCKS_MAX_BYTES],
        [TXS_TOPIC, TXS_MAX_BYTES],
    ])("%s: a message at the bound fits, one byte more does not", (topic, max) => {
        const limits = parseTopicLimits(handedOver, TOPICS)
        expect(withinTopicLimit(limits, topic, max)).toBe(true)
        expect(withinTopicLimit(limits, topic, max + 1)).toBe(false)
    })

    it("a topic without a bound never fits", () => {
        const limits = parseTopicLimits(handedOver, TOPICS)
        expect(withinTopicLimit(limits, "demos/unknown/1", 1)).toBe(false)
    })

    it.each([
        ["nothing", undefined],
        ["text that is not JSON", "{"],
        ["a number", "1024"],
        ["null", "null"],
        ["a missing topic", JSON.stringify({ [HEIGHTS_TOPIC]: 1024 })],
        ["a zero bound", JSON.stringify({ ...TOPIC_MAX_BYTES, [TXS_TOPIC]: 0 })],
        ["a non-numeric bound", JSON.stringify({ ...TOPIC_MAX_BYTES, [TXS_TOPIC]: "262144" })],
    ])("refuses to produce limits from %s", (_what, raw) => {
        expect(() => parseTopicLimits(raw, TOPICS)).toThrow()
    })

    it("the validator rejects only the oversized message and reports it once", () => {
        const limits = parseTopicLimits(handedOver, TOPICS)
        const onOversized = jest.fn()
        const validate = sizeValidator(limits, onOversized)
        const message = (topic: string, length: number) => ({ topic, data: new Uint8Array(length) })

        expect(validate(null, message(HEIGHTS_TOPIC, HEIGHTS_MAX_BYTES))).toBe("accept")
        expect(onOversized).toHaveBeenCalledTimes(0)

        expect(validate(null, message(HEIGHTS_TOPIC, HEIGHTS_MAX_BYTES + 1))).toBe("reject")
        expect(onOversized).toHaveBeenCalledTimes(1)
        expect(onOversized).toHaveBeenCalledWith(HEIGHTS_TOPIC, HEIGHTS_MAX_BYTES + 1)

        // A size that fits one topic is still judged against its own.
        expect(validate(null, message(TXS_TOPIC, HEIGHTS_MAX_BYTES + 1))).toBe("accept")
        expect(onOversized).toHaveBeenCalledTimes(1)
    })
})

describe("sidecar blocks topic validator", () => {
    const known = "ab".repeat(32)
    const blockMessage = (hash: string, padTo = 0) => {
        const body = JSON.stringify({ hash, validation_data: { signatures: {} } })
        const pad = " ".repeat(Math.max(0, padTo - body.length))
        return { topic: BLOCKS_TOPIC, data: new TextEncoder().encode(body + pad) }
    }
    const setUp = () => {
        const policy = new BlockPolicy()
        policy.remember(known)
        const consulted = jest.fn((peer: unknown, msg: unknown) => policy.validate(peer, msg))
        const onOversized = jest.fn()
        const validators = topicValidatorsFor(
            TOPICS,
            parseTopicLimits(handedOver, TOPICS),
            onOversized,
            { [SIDECAR_BLOCKS_TOPIC]: consulted },
        )
        return { validators, consulted, onOversized }
    }

    it("names the topic the parent publishes blocks on", () => {
        expect(SIDECAR_BLOCKS_TOPIC).toBe(BLOCKS_TOPIC)
    })

    it("is one validator per topic, each holding its size bound", () => {
        const { validators, onOversized } = setUp()
        expect([...validators.keys()].sort()).toEqual([...TOPICS].sort())
        for (const [topic, max] of Object.entries(TOPIC_MAX_BYTES)) {
            const validate = validators.get(topic)
            expect(validate(null, { topic, data: new Uint8Array(max + 1) })).toBe("reject")
        }
        expect(onOversized).toHaveBeenCalledTimes(TOPICS.length)
    })

    it("refuses an oversized copy of a known block before parsing it", () => {
        const { validators, consulted } = setUp()
        const validate = validators.get(BLOCKS_TOPIC)
        expect(validate(null, blockMessage(known, BLOCKS_MAX_BYTES + 1))).toBe("reject")
        expect(consulted).not.toHaveBeenCalled()
    })

    it("drops a known block within the bound and passes a new one", () => {
        const { validators, consulted } = setUp()
        const validate = validators.get(BLOCKS_TOPIC)
        expect(validate(null, blockMessage(known, BLOCKS_MAX_BYTES))).toBe("ignore")
        expect(validate(null, blockMessage("cd".repeat(32)))).toBe("accept")
        expect(consulted).toHaveBeenCalledTimes(2)
    })

    it("does not run the block check on other topics", () => {
        const { validators, consulted } = setUp()
        const data = blockMessage(known).data
        expect(validators.get(TXS_TOPIC)(null, { topic: TXS_TOPIC, data })).toBe("accept")
        expect(validators.get(HEIGHTS_TOPIC)(null, { topic: HEIGHTS_TOPIC, data })).toBe("accept")
        expect(consulted).not.toHaveBeenCalled()
    })
})

describe("sidecar IPC protocol", () => {
    it("is the same version on the node and in the sidecar", async () => {
        const versionIn = async (file: string) => {
            const source = await Bun.file(path.resolve(import.meta.dir, file)).text()
            return source.match(/^const PROTOCOL_VERSION = (\d+)$/m)?.[1]
        }
        const node = await versionIn("./GossipManager.ts")
        expect(node).toBeDefined()
        expect(await versionIn("../../../sidecar/src/index.js")).toBe(node)
    })
})
