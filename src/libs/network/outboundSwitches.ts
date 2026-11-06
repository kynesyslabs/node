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
