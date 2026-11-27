import { Config } from "src/config"
import type { OutboundConfig } from "src/config/types"

export type OutboundFeature = "xm" | "demoswork" | "web2"

/** Error code a caller sees when an operator switched the feature off. */
export const FEATURE_DISABLED = "FEATURE_DISABLED"

const SWITCHES: Record<
    OutboundFeature,
    { label: string; env: string; key: keyof OutboundConfig }
> = {
    xm: {
        label: "Cross-chain (XM) operations are",
        env: "XM_ENABLED",
        key: "xmEnabled",
    },
    demoswork: {
        label: "DemosWork scripts are",
        env: "DEMOSWORK_ENABLED",
        key: "demosWorkEnabled",
    },
    web2: {
        label: "Web2 (DAHR) requests are",
        env: "WEB2_ENABLED",
        key: "web2Enabled",
    },
}

/**
 * The refusal message when the operator switched `feature` off, else null.
 * These features make the node fetch or relay on a caller's behalf, so an
 * operator may run a validator without them.
 */
export function featureDisabledMessage(feature: OutboundFeature): string | null {
    const s = SWITCHES[feature]
    if (Config.getInstance().outbound[s.key]) return null
    return `${s.label} disabled on this node (${s.env}=false)`
}

const FEATURE_OF_TX_TYPE: Record<string, OutboundFeature> = {
    crosschainOperation: "xm",
    demoswork: "demoswork",
    web2Request: "web2",
}

const FEATURE_OF_STEP_CONTEXT: Record<string, OutboundFeature> = {
    xm: "xm",
    web2: "web2",
}

/**
 * The refusal for a tx this node would not run because its operator switched
 * the feature off, else null: the tx type itself, or a DemosWork step of a
 * switched-off kind. Node-local, for the confirm path only; peers judge the
 * tx without it, so it never feeds block validity.
 */
export function txFeatureDisabledMessage(
    type: unknown,
    script: unknown,
): string | null {
    const feature =
        typeof type === "string" && Object.hasOwn(FEATURE_OF_TX_TYPE, type)
            ? FEATURE_OF_TX_TYPE[type]
            : undefined
    if (!feature) return null
    const own = featureDisabledMessage(feature)
    if (own || feature !== "demoswork") return own

    const steps = (script as { steps?: unknown } | null)?.steps
    if (!steps || typeof steps !== "object") return null
    for (const step of Object.values(steps)) {
        const context = (step as { context?: unknown } | null)?.context
        if (
            typeof context !== "string" ||
            !Object.hasOwn(FEATURE_OF_STEP_CONTEXT, context)
        ) {
            continue
        }
        const stepOff = featureDisabledMessage(FEATURE_OF_STEP_CONTEXT[context])
        if (stepOff) return stepOff
    }
    return null
}
