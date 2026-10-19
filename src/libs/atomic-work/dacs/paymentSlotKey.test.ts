import { describe, expect, it } from "bun:test"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import {
    PAYMENT_SLOT_DOMAIN,
    computeConflictDigest,
    type PaymentSlotConflictFields,
} from "@/libs/atomic-work/dacs/paymentSlotKey"

const fields: PaymentSlotConflictFields = {
    networkId: "demos-testnet",
    railId: "native-dem",
    jobId: "job-1",
    phaseIndex: 0,
    agreementHash: "a".repeat(64),
    commitmentLogicalAddress: "stor-" + "b".repeat(64),
    payer: "c".repeat(64),
    payee: "d".repeat(64),
    asset: "DEM",
    amount: "1000000",
}

describe("computeConflictDigest", () => {
    it("pins the domain string verbatim", () => {
        expect(PAYMENT_SLOT_DOMAIN).toBe("dacs-atomic-payment-slot:v1:")
    })

    it("is domain ‖ JCS(exact field set) hashed with sha256", () => {
        const expected = Hashing.sha256(
            PAYMENT_SLOT_DOMAIN +
                jcsCanonicalize({
                    networkId: fields.networkId,
                    railId: fields.railId,
                    jobId: fields.jobId,
                    phaseIndex: fields.phaseIndex,
                    agreementHash: fields.agreementHash,
                    commitmentLogicalAddress: fields.commitmentLogicalAddress,
                    payer: fields.payer,
                    payee: fields.payee,
                    asset: fields.asset,
                    amount: fields.amount,
                }),
        )
        expect(computeConflictDigest(fields)).toBe(expected)
        expect(computeConflictDigest(fields)).toMatch(/^[0-9a-f]{64}$/)
    })

    it("rejects a non-OS-canonical amount", () => {
        expect(() =>
            computeConflictDigest({
                ...fields,
                amount: 1000000 as unknown as string,
            }),
        ).toThrow(/amount/)
    })
})
