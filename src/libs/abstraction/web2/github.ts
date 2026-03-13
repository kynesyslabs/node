import axios from "axios"
import { Octokit } from "@octokit/core"
import { Web2ProofParser } from "./parsers"
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
            console.error(error)
            throw new Error("Failed to extract gist details")
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
    ): Promise<{ message: string; type: SigningAlgorithm; signature: string }> {
        this.verifyProofFormat(proofUrl, "github")
        const { username, gistId } = this.parseGistDetails(proofUrl)
        let content: string

        // INFO: If the proofUrl is a gist.github.com url, fetch via the github api
        if (proofUrl.includes("gist.github.com")) {
            const res = await this.github.request(`GET /gists/${gistId}`, {
                headers: {
                    Accept: "application/vnd.github.raw+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            })

            if (res.status !== 200) {
                throw new Error(`Failed to read gist: ${res.status}`)
            }

            // INFO: Check if the gist owner matches the username
            if (res.data.owner.login !== username) {
                throw new Error(
                    `Gist owner does not match username: ${res.data.owner.login} !== ${username}`,
                )
            }

            const firstFile = Object.values(res.data.files)[0]
            content = firstFile["content"]
        }

        // INFO: If the proofUrl is a raw content url, fetch via axios
        if (proofUrl.includes("githubusercontent.com")) {
            const response = await axios.get(proofUrl)
            content = (response.data as string).replaceAll("\n", "")
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
