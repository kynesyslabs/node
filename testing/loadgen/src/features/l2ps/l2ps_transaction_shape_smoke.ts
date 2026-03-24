import { getRunConfig, writeJson } from "../../framework/io"
import ParallelNetworks from "../../../../../src/libs/l2ps/parallelNetworks"

export async function runL2psTransactionShapeSmoke() {
  const parallelNetworks = ParallelNetworks.getInstance() as any

  const validTx = {
    content: {
      type: "l2psEncryptedTx",
      data: [
        "l2psEncryptedTx",
        {
          l2ps_uid: "network-alpha",
          encrypted_data: "ciphertext",
        },
      ],
    },
  }

  const wrongTypeTx = {
    content: {
      type: "nativeTransfer",
      data: [],
    },
  }

  const malformedDataTx = {
    content: {
      type: "l2psEncryptedTx",
      data: ["l2psEncryptedTx"],
    },
  }

  const mismatchedPayloadTx = {
    content: {
      type: "l2psEncryptedTx",
      data: ["not-l2ps", { l2ps_uid: "network-beta" }],
    },
  }

  const cases = [
    {
      label: "detects_l2ps_transaction_type",
      actual: parallelNetworks.isL2PSTransaction(validTx),
      expected: true,
    },
    {
      label: "rejects_non_l2ps_transaction_type",
      actual: parallelNetworks.isL2PSTransaction(wrongTypeTx),
      expected: false,
    },
    {
      label: "extracts_uid_from_valid_payload",
      actual: parallelNetworks.getL2PSUidFromTransaction(validTx),
      expected: "network-alpha",
    },
    {
      label: "returns_undefined_for_non_l2ps_tx",
      actual: parallelNetworks.getL2PSUidFromTransaction(wrongTypeTx),
      expected: undefined,
    },
    {
      label: "returns_undefined_for_malformed_data",
      actual: parallelNetworks.getL2PSUidFromTransaction(malformedDataTx),
      expected: undefined,
    },
    {
      label: "returns_undefined_for_mismatched_payload_tag",
      actual: parallelNetworks.getL2PSUidFromTransaction(mismatchedPayloadTx),
      expected: undefined,
    },
  ].map(testCase => ({
    ...testCase,
    ok: testCase.actual === testCase.expected,
  }))

  const ok = cases.every(testCase => testCase.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "l2ps_transaction_shape_smoke",
    ok,
    cases,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/l2ps/l2ps_transaction_shape_smoke.summary.json`, summary)
  console.log(JSON.stringify({ l2ps_transaction_shape_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("l2ps_transaction_shape_smoke failed: transaction classification or UID extraction did not match expectations")
  }
}

if (import.meta.main) {
  await runL2psTransactionShapeSmoke()
}
