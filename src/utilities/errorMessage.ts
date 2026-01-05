export function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message
    }

    if (typeof error === "string") {
        return error
    }

    if (error && typeof error === "object" && "message" in error) {
        const potentialMessage = (error as { message?: unknown }).message
        if (typeof potentialMessage === "string") {
            return potentialMessage
        }
    }

    try {
        return JSON.stringify(error)
    } catch {
        return String(error)
    }
}
