import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { verifyCloudflareTurnstileToken } from "@/utilities/turnstile"

export class SecurityManager {
    static async verifyTurnstile(token: string): Promise<RPCResponse> {
        try {
            if (!token) {
                return {
                    result: 400,
                    response: false,
                    require_reply: false,
                    extra: "Missing Turnstile token",
                }
            }

            const isValid = await verifyCloudflareTurnstileToken(token)

            if (!isValid) {
                return {
                    result: 400,
                    response: false,
                    require_reply: false,
                    extra: "Invalid Turnstile token",
                }
            }

            return {
                result: 200,
                response: true,
                require_reply: false,
                extra: "Turnstile token verified successfully",
            }
        } catch (error) {
            return {
                result: 400,
                response: false,
                require_reply: false,
                extra: `Error verifying Turnstile token: ${error}`,
            }
        }
    }
}
