/**
 * Thrown when a Waiter event times out
 */
export class TimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "TimeoutError"
    }
}

/**
 * Thrown when a Waiter event is aborted
 */
export class AbortError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AbortError"
    }
}

export class BlockNotFoundError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BlockNotFoundError"
    }
}

export class PeerOfflineError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "PeerOfflineError"
    }
}
