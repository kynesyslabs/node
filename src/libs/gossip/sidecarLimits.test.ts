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
const { parseTopicLimits, sizeValidator, withinTopicLimit } = await import(limitsPath)

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
