
export interface ISecurityReport {
    state: boolean
    code: string
    message: string
}

export interface SIResponseRegistry {
    prune_interval: number
}

export interface SIComlink {
    rate_limit_size: number // How many comlinks can be sent in an interval? // TODO Make it configurable
    rate_limit_time: number // How many milliseconds is an interval? // TODO Make it configurable
    rate_limit_bin: number // The amount of comlinks sent in the last interval // TODO Make it configurable
    rate_limit_timestamp: number // The timestamp of the last interval
    checkRateLimits: Function
}