import { producerCommits, quorumThreshold, verifierThreshold } from "./quorum"

const SHARD_SIZES = [1, 3, 4, 7, 10]

/**
 * Every (shardSize, pool, committee, pro) a producer can be in: the
 * committee is drawn from the pool and capped at shardSize, and the pro
 * votes come from committee members, each of whom is in the pool.
 */
function* producerStates() {
    for (const shardSize of SHARD_SIZES) {
        for (let pool = 1; pool <= shardSize + 3; pool++) {
            const maxCommittee = Math.min(shardSize, pool)
            for (let committee = 1; committee <= maxCommittee; committee++) {
                for (let pro = 0; pro <= committee; pro++) {
                    yield { shardSize, pool, committee, pro }
                }
            }
        }
    }
}

describe("quorumThreshold", () => {
    it.each([
        [1, 1],
        [3, 3],
        [4, 3],
        [7, 5],
        [10, 7],
    ])("shardSize %i needs %i", (shardSize, needed) => {
        expect(quorumThreshold(shardSize)).toBe(needed)
    })
})

describe("producer and verifier parity under quorumParity", () => {
    it("sync accepts every block a producer commits", () => {
        for (const s of producerStates()) {
            if (!producerCommits(s.pro, s.committee, s.shardSize)) continue
            const needed = verifierThreshold(s.shardSize, s.pool, true)
            expect({ ...s, accepted: s.pro >= needed }).toEqual({
                ...s,
                accepted: true,
            })
        }
    })

    it("sync accepts no signer count a producer would not commit", () => {
        for (const shardSize of SHARD_SIZES) {
            for (let pool = 1; pool <= shardSize + 3; pool++) {
                for (let signers = 0; signers <= pool; signers++) {
                    if (signers < verifierThreshold(shardSize, pool, true)) {
                        continue
                    }
                    // The most favourable committee for the producer is the
                    // largest it could have polled.
                    const committee = Math.min(shardSize, pool, signers)
                    expect({
                        shardSize,
                        pool,
                        signers,
                        commits: producerCommits(signers, committee, shardSize),
                    }).toEqual({ shardSize, pool, signers, commits: true })
                }
            }
        }
    })

    it("a pool below the committee floor accepts no block", () => {
        for (const shardSize of SHARD_SIZES) {
            const floor = quorumThreshold(shardSize)
            for (let pool = 1; pool < floor; pool++) {
                expect(verifierThreshold(shardSize, pool, true)).toBeGreaterThan(
                    pool,
                )
            }
        }
    })
})

describe("pre-fork verifier", () => {
    it("accepted 2 of a pool of 2 at shardSize 4, below the producer's 3", () => {
        expect(verifierThreshold(4, 2, false)).toBe(2)
        expect(producerCommits(2, 2, 4)).toBe(false)
        expect(verifierThreshold(4, 2, true)).toBe(3)
    })

    it("matches the post-fork rule whenever the pool covers a full committee", () => {
        for (const shardSize of SHARD_SIZES) {
            for (let pool = shardSize; pool <= shardSize + 3; pool++) {
                expect(verifierThreshold(shardSize, pool, false)).toBe(
                    verifierThreshold(shardSize, pool, true),
                )
            }
        }
    })
})
