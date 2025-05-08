import axios from "axios"

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
        const secretKey = process.env.TURNSTILE_SECRET_KEY

        if (!secretKey) return false

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
        return false
    }
}
