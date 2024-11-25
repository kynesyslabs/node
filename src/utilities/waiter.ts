import { TimeoutError } from "../exceptions"
import log from "./logger"

type WaitEntry = {
    resolve: (value: any) => void
    reject: (reason?: any) => void
    timeoutId: NodeJS.Timeout
    id: string

    /**
     * Optional state data to be associated with this wait entry
     */
    data?: any
}

export class Waiter {
    static waitList: Map<string, WaitEntry> = new Map()
    static keys = {
        GREEN_LIGHT: "greenLight",
        SHARD_READY: "shardReady",
        SET_WAIT_STATUS: "setWaitStatus",
        // etc
    }

    /**
     * Registers a waitable promise with a given id
     *
     * @param id - The id of the waiter to wait for
     * @param timeout - The timeout for the waiter
     * @returns The data of the resolved waiter
     */
    static async wait<T = any>(
        id: string,
        timeout: number = 10000,
    ): Promise<T> {
        if (Waiter.waitList.has(id)) {
            throw new Error(`[WAITER] Already waiting for id: ${id}`)
        }

        return new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                Waiter.waitList.delete(id)
                reject(
                    new TimeoutError(
                        `[WAITER] Timeout waiting for response: ${id}`,
                    ),
                )
            }, timeout)

            Waiter.waitList.set(id, {
                resolve,
                reject,
                timeoutId,
                id,
            })

            log.debug(`[WAITER] Created wait entry for ${id}`)
        })
    }

    /**
     * Resolves the Promise registered with a given id with the provided data
     *
     * @param id - The id of the promise to resolve
     * @param data - The data to resolve the promise with
     */
    static resolve(id: string, data?: any) {
        const entry = Waiter.waitList.get(id)
        if (!entry) {
            log.warning(`[WAITER] No wait entry found for ${id}`)
            return
        }

        clearTimeout(entry.timeoutId)
        Waiter.waitList.delete(id)
        entry.resolve(data)
        log.debug(`[WAITER] Resolved wait entry for ${id}`)
    }

    /**
     * Checks if there is a promise registered with a given id
     *
     * @param id - The id to check
     * @returns Whether there is a promise registered with the id
     */
    static isWaiting(id: string): boolean {
        return Waiter.waitList.has(id)
    }
}

export default class MempoolLock {
    locked: boolean
    waitQueue: {
        resolve: (from: string) => void
        reject: (reason?: any) => void
        timeoutId: NodeJS.Timeout
        from: string
    }[]
    timeout: number

    constructor(timeout: number = 30000) {
        this.locked = false
        this.waitQueue = []
        this.timeout = timeout
    }

    async acquire(from: string) {
        // If not locked, acquire immediately
        if (!this.locked) {
            this.locked = true
            log.info(`[MEMPOOL LOCK] Acquired lock from ${from}`)
            return true
        }

        // Create a promise that will be resolved when it's this caller's turn
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                // Remove from queue if timeout occurs
                const index = this.waitQueue.findIndex(
                    waiter => waiter.from === from,
                )
                if (index !== -1) {
                    this.waitQueue.splice(index, 1)
                }
                reject(
                    new Error(
                        `[MEMPOOL LOCK] acquisition timeout from ${from}`,
                    ),
                )
            }, this.timeout)

            // Add to queue
            this.waitQueue.push({
                resolve,
                reject,
                timeoutId,
                from,
            })
        })
    }

    release(from: string) {
        if (!this.locked) {
            return
        }

        // Get next waiter from queue
        const nextWaiter = this.waitQueue.shift()

        if (nextWaiter) {
            clearTimeout(nextWaiter.timeoutId)
            nextWaiter.resolve(from)
        } else {
            this.locked = false
            log.info(`[MEMPOOL LOCK] Released lock from ${from}`)
        }
        // Note: lock remains true as it's being passed to next waiter
    }
}
