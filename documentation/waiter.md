## The `Waiter` class

`Waiter` is a utility class that we can use to wait for events to be triggered. It uses the Promises' `resolve` and `reject` methods paired with a timeout to force the resolution of the promise after a certain amount of time. The waiter is implemented with static methods so it can be used from anywhere without the need of instantiating a new class.

To use it, you await the resolution of a key that you set from module A, and then you trigger the resolution of that key from module B.

Here's a basic example:

```ts
// module A
queueOperation()
const data = await Waiter.wait(Waiter.keys.GREEN_LIGHT)

// module B
const data = await executeOperation()

if (data) {
    Waiter.resolve(Waiter.keys.GREEN_LIGHT, data)
}
```

The `Waiter` class is implemented as follows:

```ts
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
        timeout: number = 30000,
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
```

## The Waiter class and the Secretary system

The Secretary system can use the `Waiter` class to wait for validator status from all shard members:

-   In the Secretary routine, in the while loop, we register a waiter with the `SET_WAIT_STATUS` key/id.
    -   `await Waiter.wait(Waiter.keys.SET_WAIT_STATUS)`
-   Each shard member will use the `setWaitStatus` endpoint to set their wait status

    -   On the `setWaitStatus` endpoint handler, we can check if the received request is the last one needed to release the waiting validators
        -   If it is, we resolve the waiter, which will release all waiting shard members
            -   `Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)`
        -   If not, we update the wait status
    -   Exit normally

-   If the waiter throw a `TimeoutError`, it can mean that the timeout elapsed before all shard members have set their wait status. We can catch this exception to release the waiting shard members.

---

`Secretary.ts`

```ts
// ...
while (!this.stopSecretaryRoutine && getSharedState.inConsensusLoop) {
    try {
        await Waiter.wait(Waiter.keys.SET_WAIT_STATUS)
    } catch (error) {
        if (error instanceof TimeoutError) {
            // INFO: Release waiting validators
        }

        log.error(
            "[SECRETARY ROUTINE] Error while waiting for the set wait status request: " +
                error,
        )
    }

    // @ts-ignore
    await this.releaseWaitingValidators()
}
```

In the consensus loop, we await the resolution of the `SET_WAIT_STATUS` key. Once resolved, we release the waiting validators.

> [!NOTE]
> The abstracted function `releaseWaitingValidators` will send the `broadcastShardStatus` request to all the waiting validators.

`PorBFT.ts`

```ts
async function _updateValidatorStatus() {
    // ...

    if (wait) {
        await setWaitStatus(secretary, true)
        return await Waiter.wait(Waiter.keys.GREEN_LIGHT)
    }
}
```

When we send our validator status to the secretary, we await the resolution of the `GREEN_LIGHT` key.

`manageConsensusRoutines.ts`

```ts
case "setWaitStatus":
    // ...
    // update the wait data
    if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)) {
        // check if this is the last request needed to release the waiting validators
        // if it is, resolve the waiter
        Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)
    }
    break

case "broadcastShardStatus":
    // INFO: When a validator receives the broadcastShardStatus request, release the green light.
    // ...
    Waiter.resolve(Waiter.keys.GREEN_LIGHT)
    break
```

For the secretary, resolving `SET_WAIT_STATUS` from `manageConsensusRoutines.ts` will return in the secretary routine loop, and a `broadcastShardStatus` will be sent to all the waiting validators, which will resolve the `GREEN_LIGHT` for the waiting nodes.

The consensus routine will be driven forward by this loop until we are ready to end the consensus.

> [!TIP]
> Adopting the `Waiter` class will move the checks needed to drive things from sleep-check loops to the event handlers. 

## Concerns

1. If a validator sends a `setWaitStatus` after the current wait window, its consensus stage will be out of sync with the rest of the nodes. If that validator does not timeout, it will move forward with the consensus as driven by the secretary, but it will not have a block to vote on when the time comes.

    One way we can handle this, is to implement a mechanism on the handlers to detect if a validator is x = 1 steps behind and release its green light asap so that it can catch up. If it can't catch up, we can tell it to exit the consensus loop.

2. When checking if the received request is the last one, we need to account for nodes going offline during the consensus. When that happens, we need to update the wait data we're checking against to account for the missing nodes. Failure to do so might lead to a slow consensus as it will be driven forward by timeouts.
