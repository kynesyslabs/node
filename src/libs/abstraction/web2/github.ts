import axios from "axios"
import log from "src/utilities/logger"
import { Octokit } from "@octokit/core"
import { Web2ProofParser, Web2Claim, sameHandle, sameId } from "./parsers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { Config } from "src/config"

export class GithubProofParser extends Web2ProofParser {
    private static instance: GithubProofParser
    private github: Octokit

    constructor() {
        super()
    }

    parseGistDetails(gistUrl: string): {
        username: string
        gistId: string
    } {
        try {
            const url = new URL(gistUrl)
            const pathParts = url.pathname.split("/")
            const username = pathParts[1]
            const gistId = pathParts[2]
            return { username, gistId }
        } catch (error) {
            log.error("[GITHUB] " + error)
            throw new Error("Failed to extract gist details")
        }
    }

    /**
     * The claimed handle and id are what gets stored and rewarded, so the
     * account that published the proof has to be that very account.
     */
    private assertClaim(
        login: string,
        id: string | number,
        claim: Web2Claim,
    ) {
        if (!sameHandle(login, claim?.username)) {
            throw new Error("Proof owner does not match the claimed username")
        }
        if (!sameId(id, claim?.userId)) {
            throw new Error("Proof owner does not match the claimed user id")
        }
    }

    async login() {
        const githubToken = Config.getInstance().identity.githubToken
        if (!githubToken) {
            throw new Error("GITHUB_TOKEN is not configured")
        }

        this.github = new Octokit({
            auth: githubToken,
        })
    }

    async readData(
        proofUrl: string,
        claim: Web2Claim,
    ): Promise<{ message: string; type: SigningAlgorithm; signature: string }> {
        this.verifyProofFormat(proofUrl, "github")
        const { username, gistId } = this.parseGistDetails(proofUrl)

        // The format check is a prefix match, so the host is re-read exactly:
        // "https://raw.githubusercontent.com.example.org/" starts with an
        // accepted prefix and would otherwise be fetched from a host nobody
        // at GitHub controls.
        const host = new URL(proofUrl).hostname.toLowerCase()
        let content: string

        if (host === "gist.github.com" || host === "gist.githubusercontent.com") {
            // The gist id is what identifies a gist, not the name in front of
            // it in the URL, so the owner comes from the API.
            const res = await this.github.request(`GET /gists/${gistId}`, {
                headers: {
                    Accept: "application/vnd.github.raw+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            })

            if (res.status !== 200) {
                throw new Error(`Failed to read gist: ${res.status}`)
            }

            const owner = res.data.owner
            if (!sameHandle(owner?.login, username)) {
                throw new Error(
                    `Gist owner does not match username: ${owner?.login} !== ${username}`,
                )
            }
            this.assertClaim(owner.login, owner.id, claim)

            if (host === "gist.github.com") {
                const firstFile = Object.values(res.data.files)[0]
                content = firstFile["content"]
            } else {
                const response = await axios.get(proofUrl)
                content = (response.data as string).replaceAll("\n", "")
            }
        } else if (host === "raw.githubusercontent.com") {
            // The first path segment of a raw URL is the repository owner,
            // and only that account can publish under it. Its numeric id is
            // looked up rather than taken from the payload.
            const user = await this.github.request("GET /users/{username}", {
                username,
                headers: { "X-GitHub-Api-Version": "2022-11-28" },
            })
            if (user.status !== 200) {
                throw new Error(`Failed to read GitHub user: ${user.status}`)
            }
            this.assertClaim(user.data.login, user.data.id, claim)

            const response = await axios.get(proofUrl)
            content = (response.data as string).replaceAll("\n", "")
        } else {
            throw new Error("Unsupported GitHub proof host")
        }

        if (!content) {
            throw new Error("Failed to read content")
        }

        const payload = this.parsePayload(content)

        if (!payload) {
            throw new Error("Invalid proof format")
        }

        return payload
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new this()
            await this.instance.login()
        }

        return this.instance
    }
}
