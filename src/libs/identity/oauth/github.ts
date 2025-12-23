import log from "src/utilities/logger"

interface GitHubTokenResponse {
    access_token: string
    token_type: string
    scope: string
    error?: string
    error_description?: string
}

interface GitHubUser {
    id: number
    login: string
    name?: string
    email?: string
    avatar_url?: string
}

export interface GitHubOAuthResult {
    success: boolean
    userId?: string
    username?: string
    error?: string
}

/**
 * Exchange GitHub OAuth authorization code for access token and fetch user info
 */
export async function exchangeGitHubCode(code: string): Promise<GitHubOAuthResult> {
    const clientId = process.env.GITHUB_CLIENT_ID
    const clientSecret = process.env.GITHUB_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        log.error("[GitHub OAuth] Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET")

        return {
            success: false,
            error: "GitHub OAuth not configured on server",
        }
    }

    try {
        // Step 1: Exchange code for access token
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code: code,
            }),
        })

        const tokenData: GitHubTokenResponse = await tokenResponse.json()

        if (tokenData.error) {
            log.error(`[GitHub OAuth] Token exchange failed: ${tokenData.error_description || tokenData.error}`)
            return {
                success: false,
                error: tokenData.error_description || tokenData.error,
            }
        }

        if (!tokenData.access_token) {
            log.error("[GitHub OAuth] No access token in response")
            return {
                success: false,
                error: "Failed to obtain access token",
            }
        }

        // Step 2: Fetch user info using access token
        const userResponse = await fetch("https://api.github.com/user", {
            headers: {
                "Authorization": `Bearer ${tokenData.access_token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Demos-Identity-Service",
            },
        })

        if (!userResponse.ok) {
            log.error(`[GitHub OAuth] Failed to fetch user info: ${userResponse.status}`)
            return {
                success: false,
                error: "Failed to fetch GitHub user info",
            }
        }

        const userData: GitHubUser = await userResponse.json()

        log.info(`[GitHub OAuth] Successfully authenticated user: ${userData.login} (ID: ${userData.id})`)

        return {
            success: true,
            userId: userData.id.toString(),
            username: userData.login,
        }
    } catch (error) {
        log.error(`[GitHub OAuth] Error: ${error}`)
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error during OAuth",
        }
    }
}
