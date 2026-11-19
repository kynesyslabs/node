/**
 * The value-rule forks (`nativeSendBinding`, `canonicalAddresses`,
 * `feeBinding`) ship dormant, so existing history applies as before; the
 * mainnet genesis template and the devnet genesis set them to 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

const FORKS = ["nativeSendBinding", "canonicalAddresses", "feeBinding"] as const

describe("value-rule fork config", () => {
    let saved: ForkConfigByName

    beforeEach(() => {
        saved = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = saved
    })

    for (const name of FORKS) {
        it(`${name} is dormant by default and copied, not shared, by the clone`, () => {
            expect(DEFAULT_FORK_CONFIG[name].activationHeight).toBeNull()
            expect(isForkActive(name, 1_000_000)).toBe(false)
            const a = cloneDefaultForkConfig()
            a[name].activationHeight = 5
            expect(cloneDefaultForkConfig()[name].activationHeight).toBeNull()
        })

        it(`${name} is scheduled at 0 by the mainnet template and the devnet genesis`, () => {
            const forks = template.forks as Record<string, { activationHeight: unknown }>
            expect(forks[name].activationHeight).toBe(0)
            loadForkConfigFromGenesis(devnetGenesis)
            expect(isForkActive(name, 0)).toBe(true)
        })

        it(`${name} activates at the height a genesis names and refuses a malformed one`, () => {
            loadForkConfigFromGenesis({ forks: { [name]: { activationHeight: 100 } } })
            expect(isForkActive(name, 99)).toBe(false)
            expect(isForkActive(name, 100)).toBe(true)
            for (const activationHeight of [-1, 1.5, "0"]) {
                expect(() => loadForkConfigFromGenesis({ forks: { [name]: { activationHeight } } })).toThrow(
                    ForkConfigValidationError,
                )
            }
        })
    }
})
