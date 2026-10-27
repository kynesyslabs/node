import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import axios from "axios"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { GithubProofParser } from "./github"
import { Twitter } from "@/libs/identity/tools/twitter"
import { Discord } from "@/libs/identity/tools/discord"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

const SENDER = "ab".repeat(32)
const PROOF_TEXT = "demos:dw2p:ed25519:00ff"

type Tweet = { text: string; author: { screen_name: string; rest_id: string } }

describe("web2 proofs are bound to the claimed account", () => {
    const restores: Array<() => void> = []
    let tweets: Record<string, Tweet>
    let discordMessages: Record<string, any>
    let githubRequests: Array<{ route: string; params?: any }>
    let gists: Record<string, any>
    let users: Record<string, any>
    let rawFetches: string[]
    let rawBody: string

    beforeEach(() => {
        tweets = {}
        discordMessages = {}
        githubRequests = []
        gists = {}
        users = {}
        rawFetches = []
        rawBody = PROOF_TEXT

        // Signature checking is not what is under test here: the pool accepts
        // anything, so a failure can only come from the account binding.
        const pool = spyOn(TxValidatorPool, "getInstance").mockReturnValue({
            verify: async () => true,
        } as any)

        const twitter = spyOn(Twitter, "getInstance").mockReturnValue({
            extractTweetDetails: (url: string) => {
                const parts = new URL(url).pathname.split("/").filter(Boolean)
                return { username: parts[0], tweetId: parts[2] }
            },
            getTweetById: async (id: string) => tweets[id],
            checkIsBot: async () => false,
        } as any)

        const discord = spyOn(Discord, "getInstance").mockReturnValue({
            extractMessageDetails: (url: string) => {
                const [, , , channelId, messageId] = new URL(url).pathname.split("/")
                return { guildId: "1", channelId, messageId }
            },
            getMessageByUrl: async (url: string) =>
                discordMessages[url.split("/").pop() as string],
        } as any)

        const github = {
            request: async (route: string, params: any) => {
                githubRequests.push({ route, params })
                if (route.startsWith("GET /gists/")) {
                    const gist = gists[route.split("/").pop() as string]
                    return gist ? { status: 200, data: gist } : { status: 404, data: {} }
                }
                const user = users[params.username]
                return user ? { status: 200, data: user } : { status: 404, data: {} }
            },
        }
        const parser = new GithubProofParser()
        ;(parser as any).github = github
        const getParser = spyOn(GithubProofParser, "getInstance").mockResolvedValue(parser)

        const get = spyOn(axios, "get").mockImplementation(async (url: string) => {
            rawFetches.push(url)
            return { status: 200, data: rawBody } as any
        })

        restores.push(
            () => pool.mockRestore(),
            () => twitter.mockRestore(),
            () => discord.mockRestore(),
            () => getParser.mockRestore(),
            () => get.mockRestore(),
        )
    })
    afterEach(() => {
        while (restores.length) restores.pop()!()
    })

    describe("twitter", () => {
        const url = (handle: string) => `https://x.com/${handle}/status/1`
        const claim = (username: string, userId = "100") =>
            ({ context: "twitter", username, userId, proof: url("attacker") }) as any

        it("accepts a post by the claimed account, ignoring case", async () => {
            tweets["1"] = { text: PROOF_TEXT, author: { screen_name: "Alice", rest_id: "100" } }
            const r = await verifyWeb2Proof(
                { ...claim("alice"), proof: url("ALICE") },
                SENDER,
            )
            expect(r.success).toBe(true)
        })

        it("refuses a post from the attacker's own account under the victim's handle", async () => {
            tweets["1"] = { text: PROOF_TEXT, author: { screen_name: "attacker", rest_id: "666" } }
            const r = await verifyWeb2Proof(claim("victim", "100"), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("claimed username")
        })

        it("refuses the attacker's handle with the victim's user id", async () => {
            tweets["1"] = { text: PROOF_TEXT, author: { screen_name: "attacker", rest_id: "666" } }
            const r = await verifyWeb2Proof(claim("attacker", "100"), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("user id")
        })

        it("still refuses a tweet whose author is not the URL handle", async () => {
            tweets["1"] = { text: PROOF_TEXT, author: { screen_name: "someone", rest_id: "100" } }
            const r = await verifyWeb2Proof(
                { ...claim("someone"), proof: url("other") },
                SENDER,
            )
            expect(r.success).toBe(false)
        })
    })

    describe("github", () => {
        const claim = (proof: string, username: string, userId = "7") =>
            ({ context: "github", username, userId, proof }) as any
        const gistUrl = "https://gist.github.com/alice/g1"

        it("accepts a gist owned by the claimed account", async () => {
            gists.g1 = { owner: { login: "alice", id: 7 }, files: { a: { content: PROOF_TEXT } } }
            const r = await verifyWeb2Proof(claim(gistUrl, "Alice"), SENDER)
            expect(r.success).toBe(true)
        })

        it("refuses a gist whose owner is not the claimed username", async () => {
            gists.g1 = { owner: { login: "alice", id: 7 }, files: { a: { content: PROOF_TEXT } } }
            const r = await verifyWeb2Proof(claim(gistUrl, "victim"), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("claimed username")
        })

        it("refuses a gist whose owner id is not the claimed user id", async () => {
            gists.g1 = { owner: { login: "alice", id: 7 }, files: { a: { content: PROOF_TEXT } } }
            const r = await verifyWeb2Proof(claim(gistUrl, "alice", "8"), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("user id")
        })

        it("takes the raw gist host's owner from the API, not from the URL", async () => {
            gists.g1 = { owner: { login: "alice", id: 7 }, files: {} }
            // The URL names "victim" and the claim says "victim", but the gist
            // is alice's.
            const r = await verifyWeb2Proof(
                claim("https://gist.githubusercontent.com/victim/g1/raw/proof", "victim"),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(rawFetches).toEqual([])
        })

        it("accepts a raw gist whose real owner is the claimed account", async () => {
            gists.g1 = { owner: { login: "alice", id: 7 }, files: {} }
            const r = await verifyWeb2Proof(
                claim("https://gist.githubusercontent.com/alice/g1/raw/proof", "alice"),
                SENDER,
            )
            expect(r.success).toBe(true)
        })

        it("accepts a raw repository file under the claimed owner", async () => {
            users.alice = { login: "alice", id: 7 }
            const r = await verifyWeb2Proof(
                claim("https://raw.githubusercontent.com/alice/repo/main/proof.txt", "alice"),
                SENDER,
            )
            expect(r.success).toBe(true)
        })

        it("refuses a raw file under someone else's account claimed as the sender's own", async () => {
            users.attacker = { login: "attacker", id: 666 }
            const r = await verifyWeb2Proof(
                claim("https://raw.githubusercontent.com/attacker/repo/main/proof.txt", "victim"),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("claimed username")
        })

        it("refuses a raw file when the claimed user id belongs to another account", async () => {
            users.attacker = { login: "attacker", id: 666 }
            const r = await verifyWeb2Proof(
                claim("https://raw.githubusercontent.com/attacker/repo/main/proof.txt", "attacker", "7"),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("user id")
        })

        it("does not fetch from a look-alike host that only starts with an accepted prefix", async () => {
            const r = await verifyWeb2Proof(
                claim("https://raw.githubusercontent.com.example.org/alice/repo/proof", "alice"),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(rawFetches).toEqual([])
            expect(githubRequests).toEqual([])
        })
    })

    describe("discord", () => {
        const proof = "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
        const claim = (userId: string) =>
            ({ context: "discord", username: "alice", userId, proof }) as any

        it("accepts a message written by the claimed user", async () => {
            discordMessages["333333333333333333"] = {
                content: PROOF_TEXT,
                author: { id: "42", username: "alice" },
            }
            const r = await verifyWeb2Proof(claim("42"), SENDER)
            expect(r.success).toBe(true)
        })

        it("refuses a message written by someone else", async () => {
            discordMessages["333333333333333333"] = {
                content: PROOF_TEXT,
                author: { id: "99", username: "attacker" },
            }
            const r = await verifyWeb2Proof(claim("42"), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("claimed user id")
        })

        it("refuses a message with no author", async () => {
            discordMessages["333333333333333333"] = { content: PROOF_TEXT }
            const r = await verifyWeb2Proof(claim("42"), SENDER)
            expect(r.success).toBe(false)
        })
    })
})
