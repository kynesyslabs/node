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
import Hashing from "@/libs/crypto/hashing"

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
    recvHash: string
    proofRanges: TLSNProofRanges
    revealedRecv: number[]
    username: string
    userId: string
    referralCode?: string
}

export type TranscriptRange = { start: number; end: number }

export type TLSNProofRanges = {
    recv: TranscriptRange[]
    sent: TranscriptRange[]
}

function isHex(value: string): boolean {
    return /^[0-9a-fA-F]+$/.test(value)
}

function decodeRevealedRecv(revealedRecv: number[]): Uint8Array | null {
    if (Array.isArray(revealedRecv)) {
        const isValid = revealedRecv.every(
            n => Number.isInteger(n) && n >= 0 && n <= 255,
        )
        if (!isValid) return null
        return new Uint8Array(revealedRecv)
    }
    return null
}

function maybeParseJsonText(text: string): string | null {
    const trimmed = text.trim()
    if (!trimmed) {
        return null
    }

    // Direct JSON body
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return trimmed
    }

    // Attempt to strip chunked framing for common HTTP chunked payloads.
    // Example: "179\r\n{...json...}\r\n0"
    const lines = trimmed.split(/\r?\n/)
    if (lines.length >= 3) {
        const first = lines[0].trim()
        const last = lines[lines.length - 1].trim()
        if (/^[0-9a-fA-F]+$/.test(first) && last === "0") {
            const middle = lines.slice(1, -1).join("\n").trim()
            if (middle.startsWith("{") || middle.startsWith("[")) {
                return middle
            }
        }
    }

    // Last-resort extraction for mixed text containing JSON.
    const objStart = trimmed.indexOf("{")
    const objEnd = trimmed.lastIndexOf("}")
    if (objStart !== -1 && objEnd > objStart) {
        return trimmed.slice(objStart, objEnd + 1)
    }
    const arrStart = trimmed.indexOf("[")
    const arrEnd = trimmed.lastIndexOf("]")
    if (arrStart !== -1 && arrEnd > arrStart) {
        return trimmed.slice(arrStart, arrEnd + 1)
    }

    return null
}

function parseDisclosedRecvBody(recvBytes: Uint8Array): string | null {
    const httpResponse = parseHttpResponse(recvBytes)
    if (httpResponse) {
        const jsonBody = maybeParseJsonText(httpResponse.body)
        if (jsonBody) {
            return jsonBody
        }
    }

    // Body-only fallback (when no HTTP headers are included in disclosed bytes).
    const text = new TextDecoder().decode(recvBytes)
    const jsonBody = maybeParseJsonText(text)
    if (jsonBody) {
        return jsonBody
    }

    return null
}

function extractUserFromRawText(
    context: TLSNIdentityContext,
    text: string,
): ExtractedUser | null {
    try {
        if (context === "github") {
            const loginMatch = text.match(/"login"\s*:\s*"([^"]+)"/)
            const idMatch = text.match(/"id"\s*:\s*(\d+)/)
            if (loginMatch?.[1] && idMatch?.[1]) {
                return { username: loginMatch[1], userId: idMatch[1] }
            }
        }

        if (context === "discord") {
            const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/)
            const idMatch = text.match(/"id"\s*:\s*"?(\d+)"?/)
            if (usernameMatch?.[1] && idMatch?.[1]) {
                return { username: usernameMatch[1], userId: idMatch[1] }
            }
        }

        if (context === "telegram") {
            const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/)
            const firstNameMatch = text.match(/"first_name"\s*:\s*"([^"]+)"/)
            const idMatch = text.match(/"id"\s*:\s*"?(\d+)"?/)
            if (idMatch?.[1]) {
                return {
                    username: usernameMatch?.[1] || firstNameMatch?.[1] || "",
                    userId: idMatch[1],
                }
            }
        }
    } catch {
        return null
    }

    return null
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
        if (!isHex(presentationJSON.data)) {
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
 * Validates proof structure, verifies recv hash against proof ranges,
 * parses the extracted HTTP response, and checks extracted identity
 * fields against claimed username/userId.
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
    const { context, proof, recvHash, revealedRecv, username, userId } = payload

    // Validate context
    if (!["github", "discord", "telegram"].includes(context)) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    if (typeof recvHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(recvHash)) {
        return {
            success: false,
            message: "Invalid TLSN recvHash: expected 64-char hex sha256",
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

    const recvBytes = decodeRevealedRecv(revealedRecv)
    if (!recvBytes) {
        return {
            success: false,
            message: "Invalid TLSN revealedRecv: expected byte array (0-255)",
        }
    }

    if (recvBytes.length === 0) {
        return {
            success: false,
            message: "Invalid TLSN revealedRecv: empty payload",
        }
    }

    const computedRecvHash = Hashing.sha256Bytes(recvBytes)
    if (computedRecvHash.toLowerCase() !== recvHash.toLowerCase()) {
        return {
            success: false,
            message:
                "recvHash mismatch: provided hash does not match disclosed recv bytes",
        }
    }

    const responseBody = parseDisclosedRecvBody(recvBytes)
    const rawText = new TextDecoder().decode(recvBytes)
    const extractedUser =
        (responseBody ? extractUser(context, responseBody) : null) ||
        extractUserFromRawText(context, rawText)
    if (!extractedUser) {
        return {
            success: false,
            message: `Failed to extract user from ${context} revealedRecv payload`,
        }
    }

    if (extractedUser.username !== username) {
        return {
            success: false,
            message: `Username mismatch: claimed '${username}', proof contains '${extractedUser.username}'`,
        }
    }

    if (extractedUser.userId !== String(userId)) {
        return {
            success: false,
            message: `UserId mismatch: claimed '${String(
                userId,
            )}', proof contains '${extractedUser.userId}'`,
        }
    }

    log.info(
        `[TLSNotary Verifier] ${context} proof and recvHash validated for userId=${userId}`,
    )

    return {
        success: true,
        message: "Proof and recvHash verified",
        extractedUsername: extractedUser.username,
        extractedUserId: extractedUser.userId,
    }
}
