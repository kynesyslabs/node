import { describe, expect, test } from "bun:test"
import {
    MAX_SYNC_AGGREGATE_BITMAP_BYTES,
    MAX_SYNC_AGGREGATE_IDENTITIES,
    MAX_SYNC_AGGREGATE_IDENTITY_LENGTH,
    admitSyncAggregate,
    blockDeliveryPartition,
    buildSyncAggregate,
    buildSyncAggregateV2,
    canonicalAckIndex,
    decodeAckBits,
    encodeAckBits,
    estimatePostBlockTraffic,
    isBlockSyncAggregateV1,
    isBlockSyncAggregateV2,
    partitionIndexFor,
    shouldPublishBlock,
    syncAggregationActiveAt,
    syncDataMatchesBlock,
} from "./syncAggregation"

type V2SourceBlock = Parameters<typeof buildSyncAggregateV2>[0]

describe("block sync aggregation", () => {
    test("collects only exact-block acknowledgements deterministically", () => {
        const aggregate = buildSyncAggregate(
            { number: 42, hash: "block-42" },
            "0xSecretary",
            [
                {
                    pubkey: "0xPeerB",
                    result: {
                        result: 200,
                        response: { syncData: "1:42:block-42" },
                    },
                },
                {
                    pubkey: "0xPeerA",
                    result: {
                        result: 200,
                        response: { syncData: "1:42:block-42" },
                    },
                },
                {
                    pubkey: "0xWrongBlock",
                    result: {
                        result: 200,
                        response: { syncData: "1:41:block-41" },
                    },
                },
                {
                    pubkey: "0xFailed",
                    result: {
                        result: 500,
                        response: { syncData: "1:42:block-42" },
                    },
                },
            ],
        )

        expect(aggregate).toEqual({
            version: 1,
            blockNumber: 42,
            blockHash: "block-42",
            syncedPeerIds: ["0xpeera", "0xpeerb", "0xsecretary"],
        })
    })

    test("rejects malformed or ambiguous sync data", () => {
        expect(syncDataMatchesBlock("1:42:block-42", 42, "block-42")).toBe(true)
        expect(syncDataMatchesBlock("0:42:block-42", 42, "block-42")).toBe(
            false,
        )
        expect(
            syncDataMatchesBlock("1:42:block-42:extra", 42, "block-42"),
        ).toBe(false)
        expect(syncDataMatchesBlock("1:42x:block-42", 42, "block-42")).toBe(
            false,
        )
    })

    test("bounds aggregate work and validates the wire shape", () => {
        const responses = Array.from(
            { length: MAX_SYNC_AGGREGATE_IDENTITIES + 50 },
            (_, index) => ({
                pubkey: `peer-${index}`,
                result: {
                    result: 200,
                    response: { syncData: "1:42:block-42" },
                },
            }),
        )
        const aggregate = buildSyncAggregate(
            { number: 42, hash: "block-42" },
            "secretary",
            responses,
        )

        expect(aggregate.syncedPeerIds).toHaveLength(
            MAX_SYNC_AGGREGATE_IDENTITIES,
        )
        expect(isBlockSyncAggregateV1(aggregate)).toBe(true)
        expect(
            isBlockSyncAggregateV1({
                ...aggregate,
                syncedPeerIds: Array.from(
                    { length: MAX_SYNC_AGGREGATE_IDENTITIES + 1 },
                    (_, index) => `peer-${index}`,
                ),
            }),
        ).toBe(false)
        expect(
            isBlockSyncAggregateV1({
                ...aggregate,
                syncedPeerIds: [
                    "x".repeat(MAX_SYNC_AGGREGATE_IDENTITY_LENGTH + 1),
                ],
            }),
        ).toBe(false)
    })

    test("admits only known identities committed to the verified block", () => {
        const admission = admitSyncAggregate(
            {
                version: 1,
                blockNumber: 42,
                blockHash: "block-42",
                syncedPeerIds: [
                    "SECRETARY",
                    "peer-a",
                    "PEER-A",
                    "peer-b",
                    "unknown-peer",
                ],
            },
            {
                number: 42,
                hash: "block-42",
                validation_data: { signatures: { secretary: {} } },
                content: {
                    peerlist: [
                        { identity: "peer-a" },
                        { identity: "peer-b" },
                        { identity: "unknown-peer" },
                    ],
                },
            },
            "SECRETARY",
            "peer-b",
            ["secretary", "peer-a", "peer-b"],
        )

        expect(admission).toEqual({
            ok: true,
            acceptedPeerIds: ["secretary", "peer-a"],
        })
    })

    test("rejects a non-signer aggregate and a mismatched local block", () => {
        const aggregate = {
            version: 1,
            blockNumber: 42,
            blockHash: "block-42",
            syncedPeerIds: ["peer-a"],
        }
        const block = {
            number: 42,
            hash: "block-42",
            validation_data: { signatures: { secretary: {} } },
            content: { peerlist: [{ identity: "peer-a" }] },
        }

        expect(
            admitSyncAggregate(aggregate, block, "not-a-signer", "local", [
                "peer-a",
            ]),
        ).toEqual({
            ok: false,
            status: 403,
            message: "Sync aggregate sender did not sign the block",
        })
        expect(
            admitSyncAggregate(
                aggregate,
                { ...block, hash: "different-block" },
                "secretary",
                "local",
                ["peer-a"],
            ),
        ).toEqual({
            ok: false,
            status: 400,
            message: "Sync aggregate does not match the local chain",
        })
    })

    test("uses every signer in legacy mode and only the secretary in aggregate mode", () => {
        const committee = ["secretary", "signer-b", "signer-c", "signer-d"]

        for (const identity of committee) {
            expect(shouldPublishBlock(false, identity, committee)).toBe(true)
        }
        expect(shouldPublishBlock(true, "SECRETARY", committee)).toBe(true)
        expect(shouldPublishBlock(true, "signer-b", committee)).toBe(false)
        expect(shouldPublishBlock(true, "outsider", committee)).toBe(false)
        expect(shouldPublishBlock(true, "secretary", [])).toBe(false)
    })

    test.each([
        [5, 29, 5, 82.75],
        [20, 464, 35, 92.45],
        [30, 1004, 55, 94.52],
        [50, 2684, 95, 96.46],
        [500, 251984, 995, 99.6],
    ])(
        "%i nodes reduces the modeled request burst from %i to %i",
        (nodeCount, legacyRequests, aggregateRequests, minimumReduction) => {
            const legacy = estimatePostBlockTraffic(nodeCount, 4, false)
            const aggregate = estimatePostBlockTraffic(nodeCount, 4, true)
            const reduction =
                ((legacy.totalRequests - aggregate.totalRequests) /
                    legacy.totalRequests) *
                100

            expect(legacy.totalRequests).toBe(legacyRequests)
            expect(aggregate.totalRequests).toBe(aggregateRequests)
            expect(reduction).toBeGreaterThanOrEqual(minimumReduction)
        },
    )

    test.each([20, 30, 50, 500])(
        "%i receivers converge on the same acknowledged sync view",
        nodeCount => {
            const identities = Array.from(
                { length: nodeCount },
                (_, index) => `node-${index.toString().padStart(3, "0")}`,
            )
            const signers = identities.slice(0, 4)
            const block = {
                number: 42,
                hash: "block-42",
                validation_data: {
                    signatures: Object.fromEntries(
                        signers.map(identity => [identity, {}]),
                    ),
                },
                content: { peerlist: identities },
            }
            const aggregate = buildSyncAggregate(
                block,
                signers[0],
                identities.slice(4).map(pubkey => ({
                    pubkey,
                    result: {
                        result: 200,
                        response: { syncData: "1:42:block-42" },
                    },
                })),
            )

            for (const localIdentity of identities) {
                const admission = admitSyncAggregate(
                    aggregate,
                    block,
                    signers[0],
                    localIdentity,
                    identities,
                )
                expect(admission.ok).toBe(true)
                if ("status" in admission) continue

                const reconstructedView = new Set(admission.acceptedPeerIds)
                if (aggregate.syncedPeerIds.includes(localIdentity)) {
                    reconstructedView.add(localIdentity)
                }
                expect([...reconstructedView].sort()).toEqual(
                    aggregate.syncedPeerIds,
                )
            }
        },
    )
})

describe("block sync aggregation v2", () => {
    test.each([1, 8, 9, 500])(
        "round-trips a %i-bit acknowledgement bitmap losslessly",
        size => {
            const flags = Array.from(
                { length: size },
                (_, index) => index % 3 === 0,
            )

            expect(decodeAckBits(encodeAckBits(flags), size)).toEqual(flags)
        },
    )

    test("accepts the maximum bitmap and rejects every non-canonical payload", () => {
        const maxSize = MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8
        const maxFlags = Array.from(
            { length: maxSize },
            (_, index) => index % 7 === 0,
        )
        expect(decodeAckBits(encodeAckBits(maxFlags), maxSize)).toEqual(
            maxFlags,
        )

        // Wrong byte length: two encoded bytes against a one-byte expectation.
        expect(decodeAckBits(encodeAckBits(new Array(16).fill(true)), 8)).toBe(
            null,
        )
        // Set bit beyond expectedSize: bit 7 is valid at size 8, junk at 7.
        expect(decodeAckBits("gA==", 8)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
        ])
        expect(decodeAckBits("gA==", 7)).toBe(null)
        // Junk base64: illegal alphabet and truncated quantum.
        expect(decodeAckBits("####", 4)).toBe(null)
        expect(decodeAckBits("AQA", 4)).toBe(null)
        // Non-canonical re-encoding: "AR==" decodes to the same byte as
        // "AQ==" but was not produced by the canonical encoder.
        expect(decodeAckBits("AQ==", 1)).toEqual([true])
        expect(decodeAckBits("AR==", 1)).toBe(null)
        // Out-of-range expected sizes.
        expect(decodeAckBits(encodeAckBits([true]), 0)).toBe(null)
        expect(decodeAckBits(encodeAckBits(maxFlags), maxSize + 1)).toBe(null)
    })

    test("derives the canonical ack index from both committed peerlist shapes", () => {
        const index = canonicalAckIndex({
            number: 7,
            hash: "block-7",
            content: {
                peerlist: [
                    "PEER-B",
                    { identity: "peer-a" },
                    "peer-b",
                    { identity: "PEER-A" },
                    "y".repeat(MAX_SYNC_AGGREGATE_IDENTITY_LENGTH),
                    "x".repeat(MAX_SYNC_AGGREGATE_IDENTITY_LENGTH + 1),
                    "",
                    { notIdentity: "peer-c" },
                    42,
                ],
            },
        })

        expect(index).toEqual([
            "peer-a",
            "peer-b",
            "y".repeat(MAX_SYNC_AGGREGATE_IDENTITY_LENGTH),
        ])
        expect(canonicalAckIndex({ number: 7, hash: "block-7" })).toEqual([])
        expect(
            canonicalAckIndex({
                number: 7,
                hash: "block-7",
                content: { peerlist: "not-an-array" },
            }),
        ).toEqual([])
    })

    test("builds the exact bitmap wire object from delivery responses", () => {
        const block = {
            number: 7,
            hash: "block-7",
            content: {
                peerlist: [
                    "peer-c",
                    { identity: "PEER-A" },
                    "peer-b",
                    { identity: "sender-node" },
                ],
            },
        } as unknown as V2SourceBlock

        // Canonical index: peer-a(0) peer-b(1) peer-c(2) sender-node(3).
        // Sender bit 3 plus acked bit 1 = byte 0b00001010 = base64 "Cg==".
        const aggregate = buildSyncAggregateV2(block, "SENDER-NODE", [
            {
                pubkey: "PEER-B",
                result: {
                    result: 200,
                    response: { syncData: "1:7:block-7" },
                },
            },
            {
                pubkey: "peer-c",
                result: {
                    result: 200,
                    response: { syncData: "1:6:block-6" },
                },
            },
            {
                pubkey: "outside-the-index",
                result: {
                    result: 200,
                    response: { syncData: "1:7:block-7" },
                },
            },
        ])

        expect(aggregate).toEqual({
            version: 2,
            blockNumber: 7,
            blockHash: "block-7",
            peerlistSize: 4,
            ackBits: "Cg==",
        })
        expect(isBlockSyncAggregateV2(aggregate)).toBe(true)
        expect(
            buildSyncAggregateV2(
                {
                    number: 7,
                    hash: "block-7",
                    content: { peerlist: [] },
                } as unknown as V2SourceBlock,
                "SENDER-NODE",
                [],
            ),
        ).toBe(null)
    })

    test("validates the version-2 wire shape at every boundary", () => {
        const maxAckBitsLength =
            4 * Math.ceil(MAX_SYNC_AGGREGATE_BITMAP_BYTES / 3)
        const aggregate = {
            version: 2,
            blockNumber: 42,
            blockHash: "block-42",
            peerlistSize: 4,
            ackBits: "Cg==",
        }

        expect(isBlockSyncAggregateV2(aggregate)).toBe(true)
        expect(isBlockSyncAggregateV2(null)).toBe(false)
        expect(isBlockSyncAggregateV2([])).toBe(false)
        expect(isBlockSyncAggregateV2({ ...aggregate, version: 1 })).toBe(false)
        expect(isBlockSyncAggregateV2({ ...aggregate, version: 3 })).toBe(false)
        expect(isBlockSyncAggregateV2({ ...aggregate, blockNumber: -1 })).toBe(
            false,
        )
        expect(
            isBlockSyncAggregateV2({ ...aggregate, blockNumber: 2 ** 53 }),
        ).toBe(false)
        expect(isBlockSyncAggregateV2({ ...aggregate, blockHash: "" })).toBe(
            false,
        )
        expect(isBlockSyncAggregateV2({ ...aggregate, peerlistSize: 0 })).toBe(
            false,
        )
        expect(
            isBlockSyncAggregateV2({
                ...aggregate,
                peerlistSize: MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8,
            }),
        ).toBe(true)
        expect(
            isBlockSyncAggregateV2({
                ...aggregate,
                peerlistSize: MAX_SYNC_AGGREGATE_BITMAP_BYTES * 8 + 1,
            }),
        ).toBe(false)
        expect(
            isBlockSyncAggregateV2({
                ...aggregate,
                ackBits: "A".repeat(maxAckBitsLength),
            }),
        ).toBe(true)
        expect(
            isBlockSyncAggregateV2({
                ...aggregate,
                ackBits: "A".repeat(maxAckBitsLength + 1),
            }),
        ).toBe(false)
    })

    test("admits a bitmap aggregate excluding the local and unknown identities", () => {
        const block = {
            number: 42,
            hash: "block-42",
            validation_data: { signatures: { secretary: {} } },
            content: {
                peerlist: ["secretary", "peer-a", "peer-b", "unknown-peer"],
            },
        }
        // Index: peer-a(0) peer-b(1) secretary(2) unknown-peer(3); all four
        // bits set = byte 0b00001111 = base64 "Dw==".
        const aggregate = {
            version: 2,
            blockNumber: 42,
            blockHash: "block-42",
            peerlistSize: 4,
            ackBits: "Dw==",
        }

        expect(
            admitSyncAggregate(aggregate, block, "SECRETARY", "peer-b", [
                "secretary",
                "peer-a",
                "peer-b",
            ]),
        ).toEqual({
            ok: true,
            acceptedPeerIds: ["peer-a", "secretary"],
        })
    })

    test("rejects bitmap aggregates for the wrong chain, sender, index or bits", () => {
        const block = {
            number: 42,
            hash: "block-42",
            validation_data: { signatures: { secretary: {} } },
            content: {
                peerlist: ["secretary", "peer-a", "peer-b", "unknown-peer"],
            },
        }
        const aggregate = {
            version: 2,
            blockNumber: 42,
            blockHash: "block-42",
            peerlistSize: 4,
            ackBits: "Dw==",
        }
        const knownPeers = ["secretary", "peer-a", "peer-b"]

        expect(
            admitSyncAggregate(
                aggregate,
                { ...block, hash: "different-block" },
                "secretary",
                "local",
                knownPeers,
            ),
        ).toEqual({
            ok: false,
            status: 400,
            message: "Sync aggregate does not match the local chain",
        })
        expect(
            admitSyncAggregate(
                aggregate,
                { ...block, number: 43 },
                "secretary",
                "local",
                knownPeers,
            ),
        ).toEqual({
            ok: false,
            status: 400,
            message: "Sync aggregate does not match the local chain",
        })
        expect(
            admitSyncAggregate(aggregate, block, "peer-a", "local", knownPeers),
        ).toEqual({
            ok: false,
            status: 403,
            message: "Sync aggregate sender did not sign the block",
        })
        expect(
            admitSyncAggregate(
                { ...aggregate, peerlistSize: 5 },
                block,
                "secretary",
                "local",
                knownPeers,
            ),
        ).toEqual({
            ok: false,
            status: 400,
            message: "Sync aggregate peerlist index mismatch",
        })
        // Byte 0b00010000 = "EA==" sets only bit 4, past the 4-entry index.
        expect(
            admitSyncAggregate(
                { ...aggregate, ackBits: "EA==" },
                block,
                "secretary",
                "local",
                knownPeers,
            ),
        ).toEqual({
            ok: false,
            status: 400,
            message: "Invalid sync aggregate bitmap",
        })
    })

    test("admits a version-1 aggregate identically to its bitmap equivalent", () => {
        const block = {
            number: 42,
            hash: "block-42",
            validation_data: { signatures: { secretary: {} } },
            content: {
                peerlist: ["secretary", "peer-a", "peer-b", "unknown-peer"],
            },
        }
        const knownPeers = ["secretary", "peer-a", "peer-b"]
        const v2Admission = admitSyncAggregate(
            {
                version: 2,
                blockNumber: 42,
                blockHash: "block-42",
                peerlistSize: 4,
                ackBits: "Dw==",
            },
            block,
            "secretary",
            "peer-b",
            knownPeers,
        )
        const v1Admission = admitSyncAggregate(
            {
                version: 1,
                blockNumber: 42,
                blockHash: "block-42",
                syncedPeerIds: ["peer-a", "peer-b", "secretary", "unknown-peer"],
            },
            block,
            "secretary",
            "peer-b",
            knownPeers,
        )

        expect(v1Admission).toEqual(v2Admission)
        expect(v1Admission).toEqual({
            ok: true,
            acceptedPeerIds: ["peer-a", "secretary"],
        })
    })

    test("assigns a stable in-range partition slot for hex and non-hex identities", () => {
        expect(partitionIndexFor("0xabcdef12", 4)).toBe(2)
        expect(partitionIndexFor("0xABCDEF12", 4)).toBe(
            partitionIndexFor("0xabcdef12", 4),
        )
        expect(partitionIndexFor("not-hex-identity", 4)).toBe(
            partitionIndexFor("not-hex-identity", 4),
        )
        expect(partitionIndexFor("not-hex-identity", 4)).toBeLessThan(4)
        expect(partitionIndexFor("not-hex-identity", 4)).toBeGreaterThanOrEqual(
            0,
        )
        expect(partitionIndexFor("0xabcdef12", 0)).toBe(0)

        const slots = new Set<number>()
        for (let i = 0; i < 100; i++) {
            const identity = `0x${i.toString(16).padStart(8, "0")}`
            const slot = partitionIndexFor(identity, 5)
            expect(slot).toBe(i % 5)
            slots.add(slot)
        }
        expect([...slots].sort()).toEqual([0, 1, 2, 3, 4])
    })

    test("partitions delivery duty disjointly over exactly the non-committee peers", () => {
        const peers = Array.from(
            { length: 40 },
            (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
        )
        const committee = peers.slice(0, 4)
        const shuffledCommittee = [...committee]
            .reverse()
            .map(identity => identity.toUpperCase())

        const slices = committee.map(member =>
            blockDeliveryPartition(member, committee, peers),
        )
        const shuffledSlices = committee.map(member =>
            blockDeliveryPartition(
                member.toUpperCase(),
                shuffledCommittee,
                peers,
            ),
        )

        expect(shuffledSlices).toEqual(slices)
        const union: string[] = []
        for (const slice of slices) {
            expect(slice).not.toBe(null)
            for (const identity of slice ?? []) {
                expect(union).not.toContain(identity)
                expect(committee).not.toContain(identity)
                union.push(identity)
            }
        }
        expect(union.sort()).toEqual(peers.slice(4))

        // Peer entries keep their input casing in the returned slice.
        const mixedCasePeer = `0x${"AbCdEf00".repeat(5)}`
        expect(
            blockDeliveryPartition(committee[0], committee, [mixedCasePeer]),
        ).toEqual([mixedCasePeer])
        expect(
            blockDeliveryPartition(
                `0x${"9".repeat(40)}`,
                committee,
                peers,
            ),
        ).toBe(null)
    })

    test.each([
        [6, 44, 22, 50],
        [20, 464, 92, 80],
        [50, 2684, 242, 90.9],
        [500, 251984, 2492, 99],
    ])(
        "%i nodes reduces the version-2 burst from %i to %i requests",
        (nodeCount, legacyRequests, v2Requests, minimumReduction) => {
            const legacy = estimatePostBlockTraffic(nodeCount, 4, false)
            const v2 = estimatePostBlockTraffic(nodeCount, 4, true, 2)
            const reduction =
                ((legacy.totalRequests - v2.totalRequests) /
                    legacy.totalRequests) *
                100

            expect(legacy.totalRequests).toBe(legacyRequests)
            expect(v2).toEqual({
                nodeCount,
                signerCount: 4,
                blockPublishers: 4,
                blockDeliveries: nodeCount - 4,
                receiverSyncBroadcasts: 0,
                senderSyncBroadcasts: 0,
                aggregateBroadcasts: 4 * (nodeCount - 1),
                totalRequests: v2Requests,
            })
            expect(reduction).toBeGreaterThanOrEqual(minimumReduction)
        },
    )

    test("defaults the aggregate model to version 1 unchanged", () => {
        const defaulted = estimatePostBlockTraffic(50, 4, true)

        expect(defaulted).toEqual(estimatePostBlockTraffic(50, 4, true, 1))
        expect(defaulted.totalRequests).toBe(95)
    })

    test("activates aggregation only when enabled and at or past the height", () => {
        expect(syncAggregationActiveAt(false, 0, 100)).toBe(false)
        expect(syncAggregationActiveAt(false, 50, 100)).toBe(false)
        expect(syncAggregationActiveAt(true, 0, 0)).toBe(true)
        expect(syncAggregationActiveAt(true, 0, 100)).toBe(true)
        expect(syncAggregationActiveAt(true, 50, 49)).toBe(false)
        expect(syncAggregationActiveAt(true, 50, 50)).toBe(true)
        expect(syncAggregationActiveAt(true, 50, 51)).toBe(true)
        expect(syncAggregationActiveAt(true, -5, 0)).toBe(true)
        expect(syncAggregationActiveAt(true, 2.5, 1)).toBe(true)
        expect(syncAggregationActiveAt(true, Number.NaN, 0)).toBe(true)
    })

    test.each([20, 50, 500])(
        "%i receivers converge from four partitioned partial bitmap aggregates",
        nodeCount => {
            const identities = Array.from(
                { length: nodeCount },
                (_, index) => `node-${index.toString().padStart(3, "0")}`,
            )
            const signers = identities.slice(0, 4)
            const block = {
                number: 42,
                hash: "block-42",
                validation_data: {
                    signatures: Object.fromEntries(
                        signers.map(identity => [identity, {}]),
                    ),
                },
                content: { peerlist: identities },
            }
            const partials = signers.map(signer => {
                const slice = blockDeliveryPartition(
                    signer,
                    signers,
                    identities,
                )
                expect(slice).not.toBe(null)
                const aggregate = buildSyncAggregateV2(
                    block as unknown as V2SourceBlock,
                    signer,
                    (slice ?? []).map(pubkey => ({
                        pubkey,
                        result: {
                            result: 200,
                            response: { syncData: "1:42:block-42" },
                        },
                    })),
                )
                expect(aggregate).not.toBe(null)
                return { signer, aggregate }
            })

            for (const localIdentity of identities) {
                const acknowledged = new Set<string>()
                for (const { signer, aggregate } of partials) {
                    const admission = admitSyncAggregate(
                        aggregate,
                        block,
                        signer,
                        localIdentity,
                        identities,
                    )
                    expect(admission.ok).toBe(true)
                    if ("status" in admission) continue
                    for (const identity of admission.acceptedPeerIds) {
                        acknowledged.add(identity)
                    }
                }
                expect([...acknowledged].sort()).toEqual(
                    identities.filter(identity => identity !== localIdentity),
                )
            }
        },
    )

    test("seeded partition slots are deterministic and rotate across seeds", () => {
        const committee = ["0xaa", "0xbb", "0xcc", "0xdd"]
        const peers = Array.from(
            { length: 64 },
            (_, i) => `0x${(i + 256).toString(16).padStart(4, "0")}`,
        )

        for (const seed of ["", "block-hash-1", "block-hash-2"]) {
            const slices = committee.map(member =>
                blockDeliveryPartition(member, committee, peers, seed),
            )
            expect(slices.flatMap(slice => slice ?? []).sort()).toEqual(
                [...peers].sort(),
            )
            expect(
                blockDeliveryPartition(committee[0], committee, peers, seed),
            ).toEqual(slices[0])
        }

        const bySeed = ["block-hash-1", "block-hash-2"].map(seed =>
            peers.map(peer => partitionIndexFor(peer, committee.length, seed)),
        )
        expect(bySeed[0]).not.toEqual(bySeed[1])
        for (const assignment of bySeed) {
            for (const slot of assignment) {
                expect(slot).toBeGreaterThanOrEqual(0)
                expect(slot).toBeLessThan(committee.length)
            }
        }
    })
})
