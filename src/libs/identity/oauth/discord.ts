import log from "src/utilities/logger"
import { Hashing, ucrypto, uint8ArrayToHex, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "src/utilities/sharedState"

interface DiscordTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
    refresh_token: string
    scope: string
    error?: string
    error_description?: string
}

interface DiscordUser {
    id: string
    username: string
    discriminator: string
    global_name?: string
    avatar?: string
    email?: string
}

export interface DiscordOAuthAttestation {
    provider: "discord"
    userId: string
    username: string
    timestamp: number
    nodePublicKey: string
}

export interface SignedDiscordOAuthAttestation {
    attestation: DiscordOAuthAttestation
    signature: string
    signatureType: string
}

export interface DiscordOAuthResult {
    success: boolean
    userId?: string
    username?: string
    signedAttestation?: SignedDiscordOAuthAttestation
    error?: string
}

/**
 * Sign the OAuth attestation with the node's private key
 */
async function signAttestation(attestation: DiscordOAuthAttestation): Promise<SignedDiscordOAuthAttestation> {
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
 * Exchange Discord OAuth authorization code for access token and fetch user info
 * Returns a signed attestation that can be verified by other nodes
 */
export async function exchangeDiscordCode(code: string, redirectUri: string): Promise<DiscordOAuthResult> {
    const clientId = process.env.DISCORD_CLIENT_ID
    const clientSecret = process.env.DISCORD_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        log.error("[Discord OAuth] Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET")

        return {
            success: false,
            error: "Discord OAuth not configured on server",
        }
    }

    try {
        // Step 1: Exchange code for access token
        const tokenController = new AbortController()
        const tokenTimeoutId = setTimeout(() => tokenController.abort(), 10000) // 10-second timeout

        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "authorization_code",
                code: code,
                redirect_uri: redirectUri,
            }),
            signal: tokenController.signal,
        })
        clearTimeout(tokenTimeoutId)

        const tokenData: DiscordTokenResponse = await tokenResponse.json()

        if (tokenData.error) {
            log.error(`[Discord OAuth] Token exchange failed: ${tokenData.error_description || tokenData.error}`)
            return {
                success: false,
                error: tokenData.error_description || tokenData.error,
            }
        }

        if (!tokenData.access_token) {
            log.error("[Discord OAuth] No access token in response")
            return {
                success: false,
                error: "Failed to obtain access token",
            }
        }

        // Step 2: Fetch user info using access token
        const userController = new AbortController()
        const userTimeoutId = setTimeout(() => userController.abort(), 10000) // 10-second timeout

        const userResponse = await fetch("https://discord.com/api/users/@me", {
            headers: {
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            signal: userController.signal,
        })
        clearTimeout(userTimeoutId)

        if (!userResponse.ok) {
            log.error(`[Discord OAuth] Failed to fetch user info: ${userResponse.status}`)
            return {
                success: false,
                error: "Failed to fetch Discord user info",
            }
        }

        const userData: DiscordUser = await userResponse.json()

        // Discord usernames: use global_name if available, otherwise username#discriminator or just username
        const displayUsername = userData.global_name ||
            (userData.discriminator !== "0" ? `${userData.username}#${userData.discriminator}` : userData.username)

        log.info(`[Discord OAuth] Successfully authenticated user: ${displayUsername} (ID: ${userData.id})`)

        // Step 3: Create and sign attestation
        const nodePublicKey = getSharedState.publicKeyHex
        if (!nodePublicKey) {
            log.error("[Discord OAuth] Node public key not available")
            return {
                success: false,
                error: "Node identity not initialized",
            }
        }

        // Ensure nodePublicKey has 0x prefix (publicKeyHex doesn't include it)
        const normalizedPublicKey = nodePublicKey.startsWith("0x") ? nodePublicKey : "0x" + nodePublicKey

        const attestation: DiscordOAuthAttestation = {
            provider: "discord",
            userId: userData.id,
            username: displayUsername,
            timestamp: Date.now(),
            nodePublicKey: normalizedPublicKey,
        }

        const signedAttestation = await signAttestation(attestation)

        return {
            success: true,
            userId: userData.id,
            username: displayUsername,
            signedAttestation,
        }
    } catch (error) {
        log.error(`[Discord OAuth] Error: ${error}`)
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error during OAuth",
        }
    }
}

/**
 * Verify a signed Discord OAuth attestation
 */
export async function verifyDiscordOAuthAttestation(
    signedAttestation: SignedDiscordOAuthAttestation,
    expectedUserId: string,
    expectedUsername: string,
): Promise<{ valid: boolean; error?: string }> {
    try {
        const { attestation, signature, signatureType } = signedAttestation

        // Verify attestation data matches expected values
        if (attestation.provider !== "discord") {
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
        log.error(`[Discord OAuth] Attestation verification error: ${error}`)
        return {
            valid: false,
            error: error instanceof Error ? error.message : "Verification error",
        }
    }
}
