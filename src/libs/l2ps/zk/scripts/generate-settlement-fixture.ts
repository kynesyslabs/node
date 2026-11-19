/**
 * Proves the fixture batch with the settlement prover pool and writes the
 * proof the verifier tests use, so they run without the proving key. Run it
 * again whenever the circuit, and with it the committed verification key,
 * changes.
 *
 * Usage: bun src/libs/l2ps/zk/scripts/generate-settlement-fixture.ts
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { fixtureBatch } from "../../settlement/__fixtures__/batches"
import { planSettlement } from "../../settlement/planner"
import { proveSettlement, SETTLEMENT_VKEY_DIGEST } from "../../settlement/prover"
import { SettlementProverPool } from "../../settlement/proverPool"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, "..", "..", "settlement", "__fixtures__", "settlementProof.json")

const { transfers, balances, nonces } = fixtureBatch()
const plan = planSettlement(transfers, balances, nonces)
const pool = new SettlementProverPool({ size: 1 })
try {
    const { proof, publicSignals } = await proveSettlement(plan, pool)
    const fixture = {
        note: "Proof of fixtureBatch() in __fixtures__/batches.ts; regenerate with src/libs/l2ps/zk/scripts/generate-settlement-fixture.ts",
        vkeyDigest: SETTLEMENT_VKEY_DIGEST,
        publicSignals,
        proof,
    }
    fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n")
    console.log(`wrote ${path.relative(process.cwd(), out)}`)
} finally {
    await pool.terminate()
}
process.exit(0)
