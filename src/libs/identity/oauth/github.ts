import log from "src/utilities/logger"
import { Hashing, ucrypto, uint8ArrayToHex, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "src/utilities/sharedState"

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

export interface GitHubOAuthAttestation {
    provider: "github"
    userId: string
    username: string
    timestamp: number
    nodePublicKey: string
}

export interface SignedGitHubOAuthAttestation {
    attestation: GitHubOAuthAttestation
    signature: string
    signatureType: string
}

export interface GitHubOAuthResult {
    success: boolean
    userId?: string
    username?: string
    signedAttestation?: SignedGitHubOAuthAttestation
    error?: string
}

/**
 * Sign the OAuth attestation with the node's private key
 */
async function signAttestation(attestation: GitHubOAuthAttestation): Promise<SignedGitHubOAuthAttestation> {
    const attestationString = JSON.stringify(attestation)
    const hash = Hashing.sha256(attestationString)

    const signature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(hash),
    )

    return {
        attestation,
        signature: uint8ArrayToHex(signature.signature),
        signatureType: getSharedState.signingAlgorithm,
    }
}

/**
 * Exchange GitHub OAuth authorization code for access token and fetch user info
 * Returns a signed attestation that can be verified by other nodes
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
        const tokenController = new AbortController()
        const tokenTimeoutId = setTimeout(() => tokenController.abort(), 10000) // 10-second timeout

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
            signal: tokenController.signal,
        })
        clearTimeout(tokenTimeoutId)

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
        const userController = new AbortController()
        const userTimeoutId = setTimeout(() => userController.abort(), 10000) // 10-second timeout

        const userResponse = await fetch("https://api.github.com/user", {
            headers: {
                "Authorization": `Bearer ${tokenData.access_token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Demos-Identity-Service",
            },
            signal: userController.signal,
        })
        clearTimeout(userTimeoutId)

        if (!userResponse.ok) {
            log.error(`[GitHub OAuth] Failed to fetch user info: ${userResponse.status}`)
            return {
                success: false,
                error: "Failed to fetch GitHub user info",
            }
        }

        const userData: GitHubUser = await userResponse.json()

        log.info(`[GitHub OAuth] Successfully authenticated user: ${userData.login} (ID: ${userData.id})`)

        // Step 3: Create and sign attestation
        const nodePublicKey = getSharedState.publicKeyHex
        if (!nodePublicKey) {
            log.error("[GitHub OAuth] Node public key not available")
            return {
                success: false,
                error: "Node identity not initialized",
            }
        }

        // Ensure nodePublicKey has 0x prefix (publicKeyHex doesn't include it)
        const normalizedPublicKey = nodePublicKey.startsWith("0x") ? nodePublicKey : "0x" + nodePublicKey

        const attestation: GitHubOAuthAttestation = {
            provider: "github",
            userId: userData.id.toString(),
            username: userData.login,
            timestamp: Date.now(),
            nodePublicKey: normalizedPublicKey,
        }

        const signedAttestation = await signAttestation(attestation)

        return {
            success: true,
            userId: userData.id.toString(),
            username: userData.login,
            signedAttestation,
        }
    } catch (error) {
        log.error(`[GitHub OAuth] Error: ${error}`)
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error during OAuth",
        }
    }
}

/**
 * Verify a signed GitHub OAuth attestation
 */
export async function verifyGitHubOAuthAttestation(
    signedAttestation: SignedGitHubOAuthAttestation,
    expectedUserId: string,
    expectedUsername: string,
): Promise<{ valid: boolean; error?: string }> {
    try {
        const { attestation, signature, signatureType } = signedAttestation

        // Verify attestation data matches expected values
        if (attestation.provider !== "github") {
            return { valid: false, error: "Invalid provider in attestation" }
        }

        if (attestation.userId !== expectedUserId) {
            return { valid: false, error: "User ID mismatch in attestation" }
        }

        if (attestation.username !== expectedUsername) {
            return { valid: false, error: "Username mismatch in attestation" }
        }

        // Check attestation is not too old (e.g., 5 minutes)
        const maxAge = 5 * 60 * 1000 // 5 minutes in milliseconds
        if (Date.now() - attestation.timestamp > maxAge) {
            return { valid: false, error: "Attestation has expired" }
        }

        // Verify the signature using the node's public key from the attestation
        const attestationString = JSON.stringify(attestation)
        const hash = Hashing.sha256(attestationString)

        const isValid = await ucrypto.verify({
            algorithm: signatureType as "ed25519" | "ml-dsa" | "falcon",
            message: new TextEncoder().encode(hash),
            signature: hexToUint8Array(signature),
            publicKey: hexToUint8Array(attestation.nodePublicKey.replace("0x", "")),
        })

        if (!isValid) {
            return { valid: false, error: "Invalid attestation signature" }
        }

        return { valid: true }
    } catch (error) {
        log.error(`[GitHub OAuth] Attestation verification error: ${error}`)
        return {
            valid: false,
            error: error instanceof Error ? error.message : "Verification error",
        }
    }
}
