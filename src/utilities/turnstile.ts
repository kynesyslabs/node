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
        const response = await axios.post(
            "http://localhost:4000/api/verify-turnstile",
            { token },
        )

        // Return true if success
        return response.data?.success === true
    } catch (error) {
        return false
    }
}
