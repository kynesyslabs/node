import { declareNativeOperationKinds } from "@/libs/atomic-work/effectBoundary"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"

/**
 * What this node can execute as an atomic Work: the native operation kinds
 * and the DACS profiles. Registering is not activating — every Work is still
 * refused until the `atomicWork` fork height.
 */
export function registerAtomicWorkRuntime(): void {
    declareNativeOperationKinds()
    registerDacsAtomicWorkProfiles()
}
