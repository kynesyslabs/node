import axios from "axios"
import log from "@/utilities/logger"

/**
 * Verifies a Cloudflare Turnstile token
 *
 * @param token The Turnstile token to verify
 * @returns True if the token is valid, false otherwise
 */
export async function verifyCloudflareTurnstileToken(
    token: string,
): Promise<boolean> {
    try {
        // Get secret key from environment
        const secretKey = process.env.TURNSTILE_SECRET_KEY

        if (!secretKey) {
            log.error("Missing TURNSTILE_SECRET_KEY in environment")
            return false
        }

        // Verify the token with Cloudflare's API
        const response = await axios.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            new URLSearchParams({
                secret: secretKey,
                response: token,
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            },
        )

        // Return true if success
        return response.data?.success === true
    } catch (error) {
        log.error(`Error verifying Turnstile token: ${error}`)
        return false
    }
}
