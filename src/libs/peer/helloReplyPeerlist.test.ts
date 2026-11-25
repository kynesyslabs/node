/**
 * A hello reply contributes at most as many peer-list entries as a node
 * sends, each a `url` and a `publicKey`. Each key it names that is not online
 * gets one hello: at the listed address for a key this node does not know,
 * when that address is a node URL that does not point at this node and is
 * not the address of a peer that is online, and at the address this node
 * holds for a peer in its offline list or a staked validator, when that
 * address does not point at this node. One list reaches no more than two
 * keys this node does not know at one address. The list of a peer reached
 * that way is not followed in turn, and neither is the list of a peer
 * reached through a peer list this node is given.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "./testSupport/helloMocks"
import { HELLO_PEERLIST_SAMPLE_SIZE, helloResponseMessage } from "./helloAuth"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const BOB = "0x" + "b0".repeat(32)
const CAROL = "0x" + "c4".repeat(32)
const DAVE = "0x" + "d0".repeat(32)
const GENESIS = "d5".repeat(32)
const ALICE_URL = "http://alice.example:53550"
const BOB_URL = "http://bob.example:53550"
const CAROL_URL = "http://carol.example:53550"
const DAVE_URL = "http://dave.example:53550"
const ELSEWHERE = "http://elsewhere.example:53550"
const NONCE = "nonce"

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: "http://us.example:53550",
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    genesisBlockHash: GENESIS,
    getConsensusTime: () => 10,
    omniAdvert: null,
    markPeerOmniCapable: () => {},
    forgetPeerOmni: () => {},
}

// A stand-in scheme: a signature is the message it signs, so a reply
// verifies only if what it carries is exactly what was signed.
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
mockCore(sharedState)
mockHelloDeps({
    verify: async ({ message, signature }) =>
        hex(message) === hex(signature),
    sign: async (_algorithm, message) => ({ signature: message }),
})

// The validator table at the head: a staked key and the address committed
// with its stake, if any. A test stakes a key or makes the table unreadable.
type ValidatorRow = { address: string; connection_url: string | null }
const validators: ValidatorRow[] = []
const stake = (address: string, url: string | null) =>
    validators.push({ address, connection_url: url })
let validatorRows: () => Promise<ValidatorRow[]> = async () => validators
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlockOrThrow: () => validatorRows() },
}))

const { default: peerManager } = await import("src/libs/peer/PeerManager")
const peerModule = await import("src/libs/peer")
const { default: log } = await import("src/utilities/logger")
const sayHelloToPeer = peerManager.sayHelloToPeer

/** The proven reply of `identity` at `url` to our hello carrying `nonce`, listing `peerlist`. */
const replyFrom = (
    identity: string,
    url: string,
    nonce: string,
    peerlist: unknown,
) =>
    ({
        result: 200,
        response: true,
        require_reply: false,
        extra: {
            msg: "Peer connected",
            identity,
            url,
            signature: {
                type: "ed25519",
                data: hex(helloResponseMessage(nonce, url)),
            },
            syncData: { status: true, block: 100, block_hash: "h100" },
            genesisHash: GENESIS,
            peerlist,
        },
    }) as any

/** Alice's proven reply to our hello carrying `nonce`, listing `peerlist`. */
const reply = (nonce: string, peerlist: unknown) =>
    replyFrom(ALICE, ALICE_URL, nonce, peerlist)

/** What we take from Alice's proven reply to our hello when it lists `peerlist`. */
const replyListing = (peerlist: unknown) =>
    peerManager.helloPeerCallback(
        reply(NONCE, peerlist),
        new peerModule.Peer(ALICE_URL, ALICE),
        NONCE,
    )

beforeEach(() => {
    const manager = peerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    for (const identity of Object.keys(manager.getOfflinePeers())) {
        manager.removeOfflinePeer(identity)
    }
    validators.length = 0
    validatorRows = async () => validators
    ;(peerManager as any).sayHelloToPeer = async () => "unreachable"
    const us = new peerModule.Peer(sharedState.exposedUrl as string, OUR_KEY)
    us.sync = { status: true, block: 100, block_hash: "h100" }
    us.status = { online: true, ready: true, timestamp: Date.now() }
    manager.addPeer(us)
})

describe("the peer list of a proven hello reply", () => {
    it("is followed for no more addresses than a node sends", async () => {
        const listed = Array.from({ length: 600 }, (_, i) => ({
            url: `http://peer-${i}.example:53550`,
            publicKey: "0x" + i.toString(16).padStart(64, "0"),
        }))

        const { peers, verdict } = await replyListing(listed)

        expect(verdict).toBe("verified")
        expect(peers).toEqual(listed.slice(0, HELLO_PEERLIST_SAMPLE_SIZE))
    })

    it("is read as a node sends it when it is within that size", async () => {
        const listed = [{ url: BOB_URL, publicKey: BOB }]

        const { peers, verdict } = await replyListing(listed)

        expect(verdict).toBe("verified")
        expect(peers).toEqual(listed)
    })

    it("is read without the entries that are not an address and a key", async () => {
        const { peers } = await replyListing([
            null,
            5,
            "peer",
            { url: BOB_URL },
            { url: 7, publicKey: BOB },
            { url: BOB_URL, publicKey: BOB },
        ])

        expect(peers).toEqual([{ url: BOB_URL, publicKey: BOB }])
    })

    it("counts as empty when it is not a list", async () => {
        const { peers } = await replyListing({ length: 600 })

        expect(peers).toEqual([])
    })
})

describe("the entries of a reply's list that get a hello", () => {
    const followed: [string, string][] = []
    /** Our hello to Alice, which she answers with a proven reply listing `peerlist`. */
    const helloAnswered = (peerlist: unknown) => {
        const alice = new peerModule.Peer(ALICE_URL, ALICE)
        alice.longCall = (async (request: any) =>
            reply(request.params[0].nonce, peerlist)) as any
        return sayHelloToPeer(alice, true)
    }

    beforeEach(() => {
        followed.length = 0
        ;(peerManager as any).sayHelloToPeer = async (peer: any) => {
            followed.push([peer.identity, peer.connection.string])
            return "unreachable"
        }
    })

    it("are those for keys this node does not know, at the listed address", async () => {
        const verdict = await helloAnswered([{ url: DAVE_URL, publicKey: DAVE }])

        expect(verdict).toBe("verified")
        expect(followed).toEqual([[DAVE, DAVE_URL]])
    })

    /** A key this node has not seen, one for each `n`. */
    const unseenKey = (n: number) => "0x" + n.toString(16).padStart(64, "0")
    /** A list naming a key this node has not seen at each of `urls`, then Dave at his address. */
    const unseenAt = (urls: string[]) => [
        ...urls.map((url, i) => ({ url, publicKey: unseenKey(i + 1) })),
        { url: DAVE_URL, publicKey: DAVE },
    ]

    it("leave out a key this node does not know at an address that is not a node URL", async () => {
        await helloAnswered(
            unseenAt([
                "",
                "erin.example:53550",
                "http:erin.example:53550",
                "ftp://erin.example:53550",
                "http://erin.example:53550/rpc",
                "http://erin.example:53550?next=1",
                "http://user:secret@erin.example:53550",
            ]),
        )

        expect(followed).toEqual([[DAVE, DAVE_URL]])
    })

    it("leave out a key this node does not know at this node's own address", async () => {
        await helloAnswered(
            unseenAt([
                sharedState.exposedUrl as string,
                `${sharedState.exposedUrl}/`,
                "http://US.example:53550",
            ]),
        )

        expect(followed).toEqual([[DAVE, DAVE_URL]])
    })

    it("leave out a key this node does not know at the address of a peer that is online", async () => {
        const manager = peerManager.getInstance()
        manager.addPeer(new peerModule.Peer(BOB_URL, BOB))

        // Alice is online too, once her reply is proven.
        await helloAnswered(
            unseenAt([BOB_URL, `${BOB_URL}/`, "http://BOB.example:53550", ALICE_URL]),
        )

        expect(followed).toEqual([[DAVE, DAVE_URL]])
        expect(manager.getPeer(BOB)?.connection.string).toBe(BOB_URL)
    })

    it("reach a key this node does not know at the address of a peer in the offline list", async () => {
        const manager = peerManager.getInstance()
        manager.addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))

        await helloAnswered(unseenAt([BOB_URL]))

        expect(followed).toEqual([
            [unseenKey(1), BOB_URL],
            [DAVE, DAVE_URL],
        ])
        expect(manager.getOfflinePeers()[BOB].connection.string).toBe(BOB_URL)
    })

    const LOOPBACK_URLS = [
        "http://127.0.0.1:53550",
        "http://127.8.9.10:4000",
        "http://localhost:53551",
        "http://[::1]:53550",
    ]

    it("leave out a key this node does not know at a loopback address when the node runs with PROD", async () => {
        sharedState.prod = true
        try {
            await helloAnswered(unseenAt(LOOPBACK_URLS))
        } finally {
            delete sharedState.prod
        }

        expect(followed).toEqual([[DAVE, DAVE_URL]])
    })

    it("reach a key this node does not know at a loopback address when the node does not run with PROD", async () => {
        await helloAnswered(unseenAt(LOOPBACK_URLS))

        expect(followed).toEqual([
            ...LOOPBACK_URLS.map((url, i): [string, string] => [
                unseenKey(i + 1),
                url,
            ]),
            [DAVE, DAVE_URL],
        ])
    })

    it("reach no more than two keys this node does not know at one address", async () => {
        await helloAnswered(
            unseenAt(Array(HELLO_PEERLIST_SAMPLE_SIZE - 1).fill(ELSEWHERE)),
        )

        expect(followed).toEqual([
            [unseenKey(1), ELSEWHERE],
            [unseenKey(2), ELSEWHERE],
            [DAVE, DAVE_URL],
        ])
    })

    it("take an address written another way as the same address", async () => {
        await helloAnswered(
            unseenAt([
                ELSEWHERE,
                `${ELSEWHERE}/`,
                "http://ELSEWHERE.example:53550",
                "HTTP://elsewhere.example:53550",
            ]),
        )

        expect(followed).toEqual([
            [unseenKey(1), ELSEWHERE],
            [unseenKey(2), `${ELSEWHERE}/`],
            [DAVE, DAVE_URL],
        ])
    })

    it("take addresses that differ in scheme, host or port as different addresses", async () => {
        const urls = [
            "http://erin.example:53550",
            "https://erin.example:53550",
            "http://erin.example:53551",
            "http://frank.example:53550",
        ]

        await helloAnswered(unseenAt([...urls, ...urls, ...urls]))

        expect(followed).toEqual([
            ...[...urls, ...urls].map((url, i): [string, string] => [
                unseenKey(i + 1),
                url,
            ]),
            [DAVE, DAVE_URL],
        ])
    })

    it("reach a key this node knows at its held address, however many keys the list names there", async () => {
        const manager = peerManager.getInstance()
        manager.addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))
        stake(CAROL, BOB_URL)
        stake(DAVE, BOB_URL)

        await helloAnswered([
            { url: ELSEWHERE, publicKey: BOB },
            { url: BOB_URL, publicKey: unseenKey(1) },
            { url: ELSEWHERE, publicKey: CAROL },
            { url: BOB_URL, publicKey: unseenKey(2) },
            { url: BOB_URL, publicKey: unseenKey(3) },
            { url: ELSEWHERE, publicKey: DAVE },
            { url: ELSEWHERE, publicKey: unseenKey(4) },
            { url: ELSEWHERE, publicKey: unseenKey(5) },
        ])

        // The held addresses and the addresses listed for known keys are not
        // among the two: the third key not known at Bob's address is left out.
        expect(followed).toEqual([
            [BOB, BOB_URL],
            [unseenKey(1), BOB_URL],
            [CAROL, BOB_URL],
            [unseenKey(2), BOB_URL],
            [DAVE, BOB_URL],
            [unseenKey(4), ELSEWHERE],
            [unseenKey(5), ELSEWHERE],
        ])
    })

    it("leave out a key this node knows when its held address points at this node, which with PROD a loopback address does", async () => {
        const loopback = "http://127.0.0.1:53551"
        peerManager.getInstance().addOfflinePeer(new peerModule.Peer(loopback, BOB))
        stake(CAROL, sharedState.exposedUrl as string)
        const list = [
            { url: ELSEWHERE, publicKey: BOB },
            { url: ELSEWHERE, publicKey: CAROL },
            { url: DAVE_URL, publicKey: DAVE },
        ]

        sharedState.prod = true
        try {
            await helloAnswered(list)
        } finally {
            delete sharedState.prod
        }
        expect(followed).toEqual([[DAVE, DAVE_URL]])

        followed.length = 0
        await helloAnswered(list)
        expect(followed).toEqual([
            [BOB, loopback],
            [DAVE, DAVE_URL],
        ])
    })

    it("reach a peer in the offline list at its stored address", async () => {
        const manager = peerManager.getInstance()
        manager.addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))

        await helloAnswered([
            { url: ELSEWHERE, publicKey: BOB },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(followed).toEqual([
            [BOB, BOB_URL],
            [DAVE, DAVE_URL],
        ])
        expect(manager.getOfflinePeers()[BOB].connection.string).toBe(BOB_URL)
    })

    it("reach a staked validator this node has not seen at its committed address", async () => {
        stake(CAROL, CAROL_URL)

        await helloAnswered([
            { url: ELSEWHERE, publicKey: CAROL },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(followed).toEqual([
            [CAROL, CAROL_URL],
            [DAVE, DAVE_URL],
        ])
    })

    it("leave out a staked validator without a committed address, and log its key", async () => {
        stake(BOB, null)
        stake(CAROL, "carol.example:53550")
        const warned = (log.warning as any).mock.calls as [string][]
        warned.length = 0

        await helloAnswered([
            { url: ELSEWHERE, publicKey: BOB },
            { url: ELSEWHERE, publicKey: CAROL },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(followed).toEqual([[DAVE, DAVE_URL]])
        expect(
            warned.filter(([line]) => line.includes(BOB) && line.includes(CAROL)),
        ).toHaveLength(1)
    })

    it("reach a staked validator in the offline list at its stored address", async () => {
        peerManager.getInstance().addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))
        stake(BOB, "http://bob-at-stake.example:53550")

        await helloAnswered([{ url: ELSEWHERE, publicKey: BOB }])

        expect(followed).toEqual([[BOB, BOB_URL]])
    })

    it("leave out a peer this node lists online", async () => {
        stake(ALICE, "http://alice-at-stake.example:53550")

        await helloAnswered([
            { url: ELSEWHERE, publicKey: OUR_KEY },
            { url: ELSEWHERE, publicKey: ALICE },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(followed).toEqual([[DAVE, DAVE_URL]])
    })

    it("read a key written another way as the same key", async () => {
        const manager = peerManager.getInstance()
        manager.addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))
        stake(CAROL, CAROL_URL)
        const bare = (key: string) => key.slice(2).toUpperCase()

        await helloAnswered([
            { url: ELSEWHERE, publicKey: bare(ALICE) },
            { url: ELSEWHERE, publicKey: bare(BOB) },
            { url: ELSEWHERE, publicKey: bare(CAROL) },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(followed).toEqual([
            [BOB, BOB_URL],
            [CAROL, CAROL_URL],
            [DAVE, DAVE_URL],
        ])
    })

    it("send one hello for a key the list names more than once", async () => {
        stake(CAROL, CAROL_URL)
        ;(peerManager as any).sayHelloToPeer = sayHelloToPeer
        const dialed: [string, string][] = []
        const longCall = peerModule.Peer.prototype.longCall
        peerModule.Peer.prototype.longCall = async function (
            this: InstanceType<typeof peerModule.Peer>,
        ) {
            dialed.push([this.identity, this.connection.string])
            return { result: 500, response: false, require_reply: false, extra: {} }
        } as any

        try {
            await helloAnswered([
                { url: ELSEWHERE, publicKey: CAROL },
                { url: DAVE_URL, publicKey: CAROL },
            ])
        } finally {
            peerModule.Peer.prototype.longCall = longCall
        }

        expect(dialed).toEqual([[CAROL, CAROL_URL]])
    })

    it("are none while the validator table cannot be read", async () => {
        peerManager.getInstance().addOfflinePeer(new peerModule.Peer(BOB_URL, BOB))
        validatorRows = async () => {
            throw new Error("no database in this test")
        }

        const verdict = await helloAnswered([
            { url: ELSEWHERE, publicKey: BOB },
            { url: DAVE_URL, publicKey: DAVE },
        ])

        expect(verdict).toBe("verified")
        expect(followed).toEqual([])
    })
})

describe("the hellos one exchange starts", () => {
    type Listed = { url: string; publicKey: string }
    const longCall = peerModule.Peer.prototype.longCall
    /** The list each peer's reply carries, and the peers our hellos went to. */
    const lists = new Map<string, Listed[]>()
    const dialed: string[] = []
    const dialedAt: string[] = []
    /** Keys the node at their address no longer answers for. */
    const gone = new Set<string>()
    let keys = 0

    /** `count` peers this node has not seen, each with an address of its own. */
    const unseen = (count: number): Listed[] =>
        Array.from({ length: count }, () => {
            const n = ++keys
            return {
                url: `http://peer-${n}.example:53550`,
                publicKey: "0x" + n.toString(16).padStart(64, "0"),
            }
        })

    /** Resolves once no hello is in flight, those a reply's list started included. */
    const settled = async () => {
        for (let i = 0; i < 2000 && peerManager.verifying.size > 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 1))
        }
    }

    beforeEach(() => {
        lists.clear()
        dialed.length = 0
        dialedAt.length = 0
        gone.clear()
        keys = 0
        ;(peerManager as any).sayHelloToPeer = sayHelloToPeer
        // Every peer answers our hello with a proven reply carrying its list,
        // unless the node at its address no longer answers for its key.
        peerModule.Peer.prototype.longCall = async function (
            this: InstanceType<typeof peerModule.Peer>,
            request: any,
        ) {
            dialed.push(this.identity)
            dialedAt.push(this.connection.string)
            if (gone.has(this.identity)) {
                // What Peer.httpCall returns for a request the node refused.
                return {
                    result: 500,
                    response: "Request failed with status code 401",
                    require_reply: false,
                    extra: null,
                }
            }
            return replyFrom(
                this.identity,
                this.connection.string,
                request.params[0].nonce,
                lists.get(this.identity) ?? [],
            )
        } as any
    })

    afterEach(() => {
        peerModule.Peer.prototype.longCall = longCall
    })

    it("go to the peers its reply lists and not to the peers those list", async () => {
        const listed = unseen(HELLO_PEERLIST_SAMPLE_SIZE)
        lists.set(ALICE, listed)
        const listedByThose = listed.flatMap(({ publicKey }) => {
            const theirs = unseen(HELLO_PEERLIST_SAMPLE_SIZE)
            lists.set(publicKey, theirs)
            return theirs
        })

        const verdict = await sayHelloToPeer(
            new peerModule.Peer(ALICE_URL, ALICE),
            true,
        )
        await settled()

        const manager = peerManager.getInstance()
        expect(verdict).toBe("verified")
        expect(dialed).toHaveLength(1 + HELLO_PEERLIST_SAMPLE_SIZE)
        expect([...dialed].sort()).toEqual(
            [ALICE, ...listed.map(peer => peer.publicKey)].sort(),
        )
        expect(listed.every(peer => manager.getPeer(peer.publicKey))).toBe(true)
        expect(listedByThose).toHaveLength(HELLO_PEERLIST_SAMPLE_SIZE ** 2)
        expect(listedByThose.some(peer => manager.getPeer(peer.publicKey))).toBe(
            false,
        )
    })

    it("go to the peers a peer list names, one each, and not to the peers those list", async () => {
        // A peer list is not held to the size of a reply's list; each peer it
        // names answers with as long a list as a reply contributes.
        const listed = unseen(HELLO_PEERLIST_SAMPLE_SIZE + 8)
        const listedByThose = listed.flatMap(({ publicKey }) => {
            const theirs = unseen(HELLO_PEERLIST_SAMPLE_SIZE)
            lists.set(publicKey, theirs)
            return theirs
        })

        const manager = peerManager.getInstance()
        await manager.setPeers(
            listed.map(({ url, publicKey }) => new peerModule.Peer(url, publicKey)),
        )
        await settled()

        expect(dialed).toHaveLength(listed.length)
        expect([...dialed].sort()).toEqual(
            listed.map(peer => peer.publicKey).sort(),
        )
        expect(listed.every(peer => manager.getPeer(peer.publicKey))).toBe(true)
        expect(listedByThose).toHaveLength(
            listed.length * HELLO_PEERLIST_SAMPLE_SIZE,
        )
        expect(listedByThose.some(peer => manager.getPeer(peer.publicKey))).toBe(
            false,
        )
    })

    /** `peers` as a reply lists them when it gives each another address. */
    const listedElsewhere = (peers: Listed[]): Listed[] =>
        peers.map(({ publicKey }, i) => ({
            url: `http://listed-${i}.example:53550`,
            publicKey,
        }))

    it("reach the staked validators one anchor lists, each at its committed address", async () => {
        // Seven staked validators with this node; its peer file names Alice.
        const others = unseen(5)
        stake(OUR_KEY, sharedState.exposedUrl as string)
        stake(ALICE, ALICE_URL)
        for (const { publicKey, url } of others) stake(publicKey, url)
        lists.set(ALICE, listedElsewhere(others))

        const verdict = await sayHelloToPeer(
            new peerModule.Peer(ALICE_URL, ALICE),
            true,
        )
        await settled()

        const manager = peerManager.getInstance()
        expect(verdict).toBe("verified")
        expect([...dialedAt].sort()).toEqual(
            [ALICE_URL, ...others.map(peer => peer.url)].sort(),
        )
        expect(
            others.map(peer => manager.getPeer(peer.publicKey)?.connection.string),
        ).toEqual(others.map(peer => peer.url))
        expect(manager.getPeers()).toHaveLength(validators.length)
    })

    it("are no more than a reply's entries when those name staked validators, and stop at them", async () => {
        const named = unseen(HELLO_PEERLIST_SAMPLE_SIZE + 8)
        for (const { publicKey, url } of named) stake(publicKey, url)
        lists.set(ALICE, listedElsewhere(named))
        const listedByThose = named.flatMap(({ publicKey }) => {
            const theirs = unseen(2)
            lists.set(publicKey, theirs)
            return theirs
        })

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()

        const reached = named.slice(0, HELLO_PEERLIST_SAMPLE_SIZE)
        expect([...dialedAt].sort()).toEqual(
            [ALICE_URL, ...reached.map(peer => peer.url)].sort(),
        )
        expect(dialed).toHaveLength(1 + HELLO_PEERLIST_SAMPLE_SIZE)
        expect(listedByThose.some(peer => dialed.includes(peer.publicKey))).toBe(
            false,
        )
    })

    it("are fewer than a reply's entries when some name an address that is left out, and stop at them", async () => {
        const named = unseen(HELLO_PEERLIST_SAMPLE_SIZE + 8)
        const leftOutAt = [
            "peer.example:53550",
            sharedState.exposedUrl as string,
            "http://peer.example:53550/rpc",
        ]
        // Every fourth entry a reply contributes names an address that is left out.
        const listed = named.map((peer, i) =>
            i % 4 === 0
                ? { ...peer, url: leftOutAt[(i / 4) % leftOutAt.length] }
                : peer,
        )
        lists.set(ALICE, listed)
        const listedByThose = named.flatMap(({ publicKey }) => {
            const theirs = unseen(2)
            lists.set(publicKey, theirs)
            return theirs
        })

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()

        const reached = named
            .slice(0, HELLO_PEERLIST_SAMPLE_SIZE)
            .filter((_, i) => i % 4 !== 0)
        expect(reached).toHaveLength((HELLO_PEERLIST_SAMPLE_SIZE * 3) / 4)
        expect([...dialedAt].sort()).toEqual(
            [ALICE_URL, ...reached.map(peer => peer.url)].sort(),
        )
        expect([...dialed].sort()).toEqual(
            [ALICE, ...reached.map(peer => peer.publicKey)].sort(),
        )
        expect(listedByThose.some(peer => dialed.includes(peer.publicKey))).toBe(
            false,
        )
    })

    it("are two when a reply's entries all name one address for keys this node does not know", async () => {
        const listed = unseen(HELLO_PEERLIST_SAMPLE_SIZE).map(peer => ({
            ...peer,
            url: ELSEWHERE,
        }))
        lists.set(ALICE, listed)

        const verdict = await sayHelloToPeer(
            new peerModule.Peer(ALICE_URL, ALICE),
            true,
        )
        await settled()

        expect(verdict).toBe("verified")
        expect(dialedAt).toEqual([ALICE_URL, ELSEWHERE, ELSEWHERE])
        expect(dialed).toEqual([ALICE, listed[0].publicKey, listed[1].publicKey])
    })

    it("are no more than a reply's entries when those name two keys at each address, and stop at them", async () => {
        const named = unseen(HELLO_PEERLIST_SAMPLE_SIZE + 8).map((peer, i) => ({
            ...peer,
            url: `http://shared-${Math.floor(i / 2)}.example:53550`,
        }))
        lists.set(ALICE, named)
        const listedByThose = named.flatMap(({ publicKey }) => {
            const theirs = unseen(2)
            lists.set(publicKey, theirs)
            return theirs
        })

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()

        const reached = named.slice(0, HELLO_PEERLIST_SAMPLE_SIZE)
        expect([...dialedAt].sort()).toEqual(
            [ALICE_URL, ...reached.map(peer => peer.url)].sort(),
        )
        expect([...dialed].sort()).toEqual(
            [ALICE, ...reached.map(peer => peer.publicKey)].sort(),
        )
        expect(listedByThose.some(peer => dialed.includes(peer.publicKey))).toBe(
            false,
        )
    })

    it("reach a key this node does not know at an address held for a peer in the offline list, which its proven reply moves to it", async () => {
        // Carol is in the offline list; the node at her address now answers
        // with a key this node has not seen.
        const manager = peerManager.getInstance()
        manager.addOfflinePeer(new peerModule.Peer(CAROL_URL, CAROL))
        const [atCarols] = unseen(1)
        lists.set(ALICE, [{ url: CAROL_URL, publicKey: atCarols.publicKey }])

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()

        expect(dialedAt).toEqual([ALICE_URL, CAROL_URL])
        expect(manager.getPeer(atCarols.publicKey)?.connection.string).toBe(
            CAROL_URL,
        )
        expect(manager.getOfflinePeers()[CAROL]).toBeUndefined()
    })

    it("do not go to the address of a peer that is online for a key this node does not know", async () => {
        const manager = peerManager.getInstance()
        manager.addPeer(new peerModule.Peer(BOB_URL, BOB))
        const [atBobs, another] = unseen(2)
        lists.set(ALICE, [
            { url: BOB_URL, publicKey: atBobs.publicKey },
            { url: BOB_URL, publicKey: another.publicKey },
        ])

        const verdict = await sayHelloToPeer(
            new peerModule.Peer(ALICE_URL, ALICE),
            true,
        )
        await settled()

        expect(verdict).toBe("verified")
        expect(dialedAt).toEqual([ALICE_URL])
        expect(manager.getPeer(BOB)?.connection.string).toBe(BOB_URL)
        expect(manager.getPeer(atBobs.publicKey)).toBeUndefined()
    })

    it("find a node that changed its key at its old address once its old key no longer answers there", async () => {
        // Bob is online; the node at his address now answers with a key this
        // node has not seen, and takes no request that names Bob.
        const manager = peerManager.getInstance()
        manager.addPeer(new peerModule.Peer(BOB_URL, BOB))
        const [atBobs] = unseen(1)
        lists.set(ALICE, [{ url: BOB_URL, publicKey: atBobs.publicKey }])
        gone.add(BOB)

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()
        expect(dialedAt).toEqual([ALICE_URL])
        expect(manager.getPeer(BOB)?.connection.string).toBe(BOB_URL)

        // Our next hello to Bob is not answered: he is listed offline.
        const verdict = await sayHelloToPeer(manager.getPeer(BOB), true)
        expect(verdict).toBe("unreachable")
        expect(manager.getPeer(BOB)).toBeUndefined()
        expect(manager.getOfflinePeers()[BOB].connection.string).toBe(BOB_URL)

        await sayHelloToPeer(new peerModule.Peer(ALICE_URL, ALICE), true)
        await settled()
        expect(dialedAt).toEqual([ALICE_URL, BOB_URL, ALICE_URL, BOB_URL])
        expect(dialed).toEqual([ALICE, BOB, ALICE, atBobs.publicKey])
        expect(manager.getPeer(atBobs.publicKey)?.connection.string).toBe(BOB_URL)
        expect(manager.getOfflinePeers()[BOB]).toBeUndefined()
    })
})
