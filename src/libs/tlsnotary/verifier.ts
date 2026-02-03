/**
 * TLSNotary Proof Verifier for Node
 *
 * Validates TLSNotary presentation structure server-side.
 *
 * NOTE: Full cryptographic verification via WASM is not currently supported
 * in Node.js CommonJS environments. This module validates proof structure
 * and trusts client-provided claims. The actual cryptographic verification
 * happens on the frontend (browser) where WASM works properly.
 *
 * TODO: Enable full WASM verification when tlsn-js supports Node.js properly.
 */
import log from "@/utilities/logger"

/**
 * TLSNotary presentation format (from tlsn-js attestation)
 */
export interface TLSNotaryPresentation {
    /** TLSNotary version (e.g., "0.1.0-alpha.12") */
    version: string
    /** Hex-encoded proof data containing request/response and signatures */
    data: string
    /** Metadata about the attestation */
    meta: {
        notaryUrl?: string
        websocketProxyUrl?: string
    }
}

/**
 * Result of TLSNotary proof verification
 */
export interface TLSNotaryVerificationResult {
    success: boolean
    serverName?: string
    sent?: Uint8Array | string
    recv?: Uint8Array | string
    time?: number
    verifyingKey?: string
    error?: string
}

/**
 * Parsed HTTP response structure
 */
export interface ParsedHttpResponse {
    statusLine: string
    headers: Record<string, string>
    body: string
}

/**
 * Supported TLSN identity contexts
 */
export type TLSNIdentityContext = "github" | "discord" | "telegram"

/**
 * Extracted user data (generic for all platforms)
 */
export interface ExtractedUser {
    username: string
    userId: string
}

/**
 * TLSN identity payload structure for verification
 */
export interface TLSNIdentityPayload {
    context: TLSNIdentityContext
    proof: TLSNotaryPresentation
    username: string
    userId: string
    referralCode?: string
}

/**
 * Initialize TLSNotary verifier (no-op in current implementation)
 *
 * This function exists for API compatibility. Full WASM initialization
 * is not supported in Node.js CommonJS environments.
 */
export async function initTLSNotaryVerifier(): Promise<void> {
    log.info(
        "[TLSNotary Verifier] Structure-only verification mode (WASM not available in Node.js)",
    )
}

/**
 * Check if the verifier is initialized
 *
 * Always returns true since structure validation doesn't require initialization.
 */
export function isVerifierInitialized(): boolean {
    return true
}

/**
 * Verify a TLSNotary presentation structure
 *
 * Validates that the presentation has the required fields and format.
 * Does NOT perform cryptographic verification (that happens on frontend).
 *
 * @param presentationJSON - The TLSNotary presentation to verify
 * @returns Verification result
 */
export async function verifyTLSNotaryPresentation(
    presentationJSON: TLSNotaryPresentation,
): Promise<TLSNotaryVerificationResult> {
    try {
        // Validate presentation structure
        if (!presentationJSON || typeof presentationJSON !== "object") {
            return {
                success: false,
                error: "Invalid presentation: expected object",
            }
        }

        if (
            !presentationJSON.data ||
            typeof presentationJSON.data !== "string"
        ) {
            return {
                success: false,
                error: "Invalid presentation: missing or invalid 'data' field",
            }
        }

        if (
            !presentationJSON.version ||
            typeof presentationJSON.version !== "string"
        ) {
            return {
                success: false,
                error: "Invalid presentation: missing or invalid 'version' field",
            }
        }

        // Validate data is hex-encoded (basic check)
        if (!/^[0-9a-fA-F]+$/.test(presentationJSON.data)) {
            return {
                success: false,
                error: "Invalid presentation: 'data' field is not valid hex",
            }
        }

        // Minimum data length check (a valid proof should have substantial data)
        if (presentationJSON.data.length < 100) {
            return {
                success: false,
                error: "Invalid presentation: 'data' field is too short",
            }
        }

        log.info("[TLSNotary Verifier] Proof structure validated successfully")

        return {
            success: true,
            time: Date.now(),
            verifyingKey: "structure-validation-only",
        }
    } catch (error) {
        log.error(`[TLSNotary Verifier] Verification failed: ${error}`)
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

/**
 * Parse HTTP response from recv bytes
 *
 * Extracts the status line, headers, and body from raw HTTP response bytes.
 *
 * @param recv - Raw HTTP response bytes from TLSNotary verification
 * @returns Parsed HTTP response or null if parsing fails
 */
export function parseHttpResponse(
    recv: Uint8Array | string,
): ParsedHttpResponse | null {
    try {
        const text =
            typeof recv === "string" ? recv : new TextDecoder().decode(recv)

        // Find the end of headers (double CRLF)
        const headerEndIndex = text.indexOf("\r\n\r\n")
        if (headerEndIndex === -1) {
            log.warn(
                "[TLSNotary Verifier] No header/body separator found in response",
            )
            return null
        }

        const headerSection = text.slice(0, headerEndIndex)
        const body = text.slice(headerEndIndex + 4)

        const headerLines = headerSection.split("\r\n")
        const statusLine = headerLines[0] || ""

        const headers: Record<string, string> = {}
        for (let i = 1; i < headerLines.length; i++) {
            const colonIndex = headerLines[i].indexOf(":")
            if (colonIndex !== -1) {
                const key = headerLines[i]
                    .slice(0, colonIndex)
                    .trim()
                    .toLowerCase()
                const value = headerLines[i].slice(colonIndex + 1).trim()
                headers[key] = value
            }
        }

        return { statusLine, headers, body }
    } catch (error) {
        log.error(
            `[TLSNotary Verifier] Failed to parse HTTP response: ${error}`,
        )
        return null
    }
}

/**
 * Extract user data from API response body based on context
 *
 * Parses the JSON response from the platform's API and extracts
 * the username and user ID based on the context.
 *
 * @param context - The platform context (github, discord, telegram)
 * @param responseBody - The JSON body from the platform's API endpoint
 * @returns Extracted user data or null if extraction fails
 */
export function extractUser(
    context: TLSNIdentityContext,
    responseBody: string,
): ExtractedUser | null {
    try {
        const json = JSON.parse(responseBody)

        switch (context) {
            case "github":
                if (json.login && json.id !== undefined) {
                    return {
                        username: json.login,
                        userId: String(json.id),
                    }
                }
                log.warn(
                    "[TLSNotary Verifier] GitHub response missing 'login' or 'id' fields",
                )
                return null

            case "discord":
                if (json.username && json.id !== undefined) {
                    return {
                        username: json.username,
                        userId: String(json.id),
                    }
                }
                log.warn(
                    "[TLSNotary Verifier] Discord response missing 'username' or 'id' fields",
                )
                return null

            case "telegram": {
                // Handle response format: { user: { id, username, first_name, ... } }
                const user = json.user || json
                if (user.id !== undefined) {
                    return {
                        username: user.username || user.first_name || "",
                        userId: String(user.id),
                    }
                }
                log.warn(
                    "[TLSNotary Verifier] Telegram response missing 'id' field",
                )
                return null
            }

            default:
                log.warn(`[TLSNotary Verifier] Unsupported context: ${context}`)
                return null
        }
    } catch (error) {
        log.error(
            `[TLSNotary Verifier] Failed to parse ${context} response: ${error}`,
        )
        return null
    }
}

/**
 * Verify a TLSNotary proof for any supported context
 *
 * Validates the proof structure. The cryptographic verification is done
 * on the frontend. This function trusts the claimed username/userId
 * after validating the proof has a valid structure.
 *
 * @param payload - The TLSN identity payload containing context, proof, username, and userId
 * @returns Verification result
 */
export async function verifyTLSNProof(payload: TLSNIdentityPayload): Promise<{
    success: boolean
    message: string
    extractedUsername?: string
    extractedUserId?: string
}> {
    const { context, proof, username, userId } = payload

    // Validate context
    if (!["github", "discord", "telegram"].includes(context)) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    // Verify the proof structure
    const verified = await verifyTLSNotaryPresentation(proof)
    if (!verified.success) {
        return {
            success: false,
            message: `Proof verification failed: ${verified.error}`,
        }
    }

    log.info(
        `[TLSNotary Verifier] ${context} proof structure validated for: username=${username}, userId=${userId}`,
    )

    return {
        success: true,
        message: "Proof structure verified",
        extractedUsername: username,
        extractedUserId: userId,
    }
}
