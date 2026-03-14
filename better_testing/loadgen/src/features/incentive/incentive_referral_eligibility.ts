import { getRunConfig, writeJson } from "../../framework/io"
import { Referrals } from "../../../../../src/features/incentive/referrals"

export async function runIncentiveReferralEligibility() {
  const eligibleAccount = {
    referralInfo: {
      referralCode: "DEM12345",
      totalReferrals: 0,
      referrals: [],
      referredBy: null,
    },
    points: {
      totalPoints: 0,
    },
  } as any

  const referrerAccount = {
    referralInfo: {
      referrals: [
        { referredUserId: "alice" },
        { referredUserId: "bob" },
      ],
    },
  } as any

  const cases = [
    {
      label: "eligible_when_clean",
      actual: Referrals.isEligibleForReferral(eligibleAccount),
      expected: true,
    },
    {
      label: "ineligible_when_referred_by_present",
      actual: Referrals.isEligibleForReferral({
        ...eligibleAccount,
        referralInfo: { ...eligibleAccount.referralInfo, referredBy: "parent" },
      } as any),
      expected: false,
    },
    {
      label: "ineligible_when_referrals_exist",
      actual: Referrals.isEligibleForReferral({
        ...eligibleAccount,
        referralInfo: {
          ...eligibleAccount.referralInfo,
          referrals: [{ referredUserId: "child" }],
        },
      } as any),
      expected: false,
    },
    {
      label: "ineligible_when_total_referrals_gt_zero",
      actual: Referrals.isEligibleForReferral({
        ...eligibleAccount,
        referralInfo: { ...eligibleAccount.referralInfo, totalReferrals: 1 },
      } as any),
      expected: false,
    },
    {
      label: "ineligible_when_points_gt_zero",
      actual: Referrals.isEligibleForReferral({
        ...eligibleAccount,
        points: { totalPoints: 3 },
      } as any),
      expected: false,
    },
    {
      label: "already_referred_detected",
      actual: Referrals.isAlreadyReferred(referrerAccount, "bob"),
      expected: true,
    },
    {
      label: "already_referred_absent_for_new_user",
      actual: Referrals.isAlreadyReferred(referrerAccount, "charlie"),
      expected: false,
    },
  ].map(testCase => ({
    ...testCase,
    ok: testCase.actual === testCase.expected,
  }))

  const ok = cases.every(testCase => testCase.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "incentive_referral_eligibility",
    ok,
    cases,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/incentive/incentive_referral_eligibility.summary.json`, summary)
  console.log(JSON.stringify({ incentive_referral_eligibility_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("incentive_referral_eligibility failed: referral eligibility logic did not match expectations")
  }
}

if (import.meta.main) {
  await runIncentiveReferralEligibility()
}
