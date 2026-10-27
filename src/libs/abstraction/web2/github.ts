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
        // Only gists are accepted. A repository file cannot prove who wrote
        // it: raw.githubusercontent.com serves a fork's commits and pull
        // request refs under the parent repository's path, and collaborators
        // push there too, so the owner in the URL is not the author.
        let host: string
        try {
            host = new URL(proofUrl).hostname.toLowerCase()
        } catch {
            throw new Error("Invalid GitHub proof URL")
        }
        if (host !== "gist.github.com" && host !== "gist.githubusercontent.com") {
            throw new Error(
                "GitHub proofs must be gists (gist.github.com or gist.githubusercontent.com)",
            )
        }
        this.verifyProofFormat(proofUrl, "github")
        const { username, gistId } = this.parseGistDetails(proofUrl)
        if (!gistId || !/^[0-9a-fA-F]+$/.test(gistId)) {
            throw new Error("Invalid gist id")
        }

        // The gist id is what identifies a gist, not the name in front of it
        // in the URL, so the owner comes from the API.
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

        // The content is read from the same API response that named the
        // owner. Fetching the URL instead would let its raw/<revision> segment
        // pick an older revision, or a different gist altogether, after the
        // owner check.
        const file = this.pickGistFile(res.data.files, proofUrl)
        if (!file || file.truncated) {
            throw new Error("Failed to read gist content")
        }
        const content =
            typeof file.content === "string"
                ? file.content.replaceAll("\n", "")
                : ""

        if (!content) {
            throw new Error("Failed to read content")
        }

        const payload = this.parsePayload(content)

        if (!payload) {
            throw new Error("Invalid proof format")
        }

        return payload
    }

    /**
     * The file a raw gist URL names (its last path segment), or the gist's
     * first file. The revision in the URL is ignored on purpose.
     */
    private pickGistFile(
        files: Record<string, any> | undefined,
        proofUrl: string,
    ): { content?: string; truncated?: boolean } | undefined {
        if (!files || typeof files !== "object") return undefined
        const named = decodeURIComponent(
            new URL(proofUrl).pathname.split("/").filter(Boolean).pop() ?? "",
        )
        const byName = Object.values(files).find(f => f?.filename === named)
        return byName ?? files[named] ?? Object.values(files)[0]
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new this()
            await this.instance.login()
        }

        return this.instance
    }
}
