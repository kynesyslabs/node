export class TimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "TimeoutError"
    }
}

export class WaiterIndexError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "WaiterIndexError"
    }
}
