import { getRunConfig, writeJson } from "../../framework/io"
import { Referrals } from "../../../../../src/features/incentive/referrals"

const PUBLIC_KEY = `0x${"12".repeat(32)}`

export async function runIncentiveReferralCodeSmoke() {
  const defaultCode = Referrals.generateReferralCode(PUBLIC_KEY)
  const repeatedCode = Referrals.generateReferralCode(PUBLIC_KEY)
  const shortCode = Referrals.generateReferralCode(PUBLIC_KEY, { length: 8 })
  const checksummedCode = Referrals.generateReferralCode(PUBLIC_KEY, {
    length: 12,
    includeChecksum: true,
  })
  const prefixedCode = Referrals.generateReferralCode(PUBLIC_KEY, {
    length: 10,
    prefix: "DEM-",
  })

  let invalidKeyError: string | null = null
  try {
    Referrals.generateReferralCode("0x1234")
  } catch (error) {
    invalidKeyError = (error as Error).message
  }

  const checks = {
    deterministic: defaultCode === repeatedCode,
    defaultLength: defaultCode.length === 12,
    shortLength: shortCode.length === 8,
    checksumLength: checksummedCode.length === 12,
    checksumDiffersFromDefault: checksummedCode !== defaultCode,
    prefixApplied: prefixedCode.startsWith("DEM-") && prefixedCode.length === 14,
    invalidKeyRejected: invalidKeyError?.includes("64 hex characters") ?? false,
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "incentive_referral_code_smoke",
    ok,
    checks,
    samples: {
      defaultCode,
      shortCode,
      checksummedCode,
      prefixedCode,
    },
    invalidKeyError,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/incentive/incentive_referral_code_smoke.summary.json`, summary)
  console.log(JSON.stringify({ incentive_referral_code_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("incentive_referral_code_smoke failed: referral code behavior did not match expectations")
  }
}

if (import.meta.main) {
  await runIncentiveReferralCodeSmoke()
}
