import { describe, expect, test } from "bun:test"
import {
    MAX_SYNC_AGGREGATE_IDENTITIES,
    MAX_SYNC_AGGREGATE_IDENTITY_LENGTH,
    admitSyncAggregate,
    buildSyncAggregate,
    estimatePostBlockTraffic,
    isBlockSyncAggregateV1,
    shouldPublishBlock,
    syncDataMatchesBlock,
} from "./syncAggregation"

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
