# Production ZK Keys Regeneration Guide

**CRITICAL:** The current `verification_key_merkle.json` has identical `vk_gamma_2` and `vk_delta_2` values, indicating an unsafe trusted setup that compromises proof security.

This guide regenerates production-safe verification keys for the Merkle circuit.

---

## Prerequisites

Ensure you have:
- [x] Node.js/Bun installed
- [x] `circom2` installed (`npm install -g circom2`)
- [x] `snarkjs` installed (`npm install -g snarkjs`)
- [x] Repository cloned and dependencies installed

---

## Step 1: Clean Old Keys

```bash
# Remove the unsafe verification key (backup first)
cd /home/tcsenpai/kynesys/node
cp src/features/zk/keys/verification_key_merkle.json src/features/zk/keys/verification_key_merkle.json.UNSAFE_BACKUP
rm src/features/zk/keys/identity_with_merkle_0000.zkey

# Keep the PTAU file (it's legitimate)
# Keep verification_key.json (basic circuit, not affected by this issue)
```

---

## Step 2: Regenerate Keys

Run the automated setup script:

```bash
bun run zk:setup-all
```

This will:
1. ✅ Verify PTAU file integrity (already downloaded, ~140MB)
2. ✅ Recompile `identity_with_merkle.circom` circuit
3. ✅ Generate initial `identity_with_merkle_0000.zkey` (phase 0)
4. ✅ Add random contribution creating `identity_with_merkle_0001.zkey` (phase 1)
5. ✅ Export NEW `verification_key_merkle.json` with distinct gamma/delta from contributed key

**Expected output:**
```
[1/3] Download Powers of Tau Ceremony File
  ✓ Powers of Tau file already exists
  ✓ File integrity verified

[2/3] Compile Circom Circuits
  → Compiling identity_with_merkle.circom...
  ✓ Compiling identity_with_merkle.circom complete

[3/3] Generate Proving and Verification Keys
  → Generating proving key (this may take 10-30 seconds)...
  ✓ Proving key generated
  → Exporting verification key...
  ✓ Verification key exported
    → src/features/zk/keys/verification_key_merkle.json
```

---

## Step 3: Verify Key Safety

Run this verification script to ensure gamma ≠ delta:

```bash
# Quick verification check
node -e "
const vk = require('./src/features/zk/keys/verification_key_merkle.json');
const gamma = JSON.stringify(vk.vk_gamma_2);
const delta = JSON.stringify(vk.vk_delta_2);
if (gamma === delta) {
  console.error('❌ CRITICAL: vk_gamma_2 and vk_delta_2 are still identical!');
  process.exit(1);
} else {
  console.log('✅ SUCCESS: vk_gamma_2 and vk_delta_2 are distinct');
  console.log('   Verification key is production-safe');
}
"
```

Expected output:
```
✅ SUCCESS: vk_gamma_2 and vk_delta_2 are distinct
   Verification key is production-safe
```

---

## Step 4: Commit New Verification Key

```bash
# Add the NEW production-safe verification key
git add src/features/zk/keys/verification_key_merkle.json

# Commit with clear message
git commit -m "SECURITY: Regenerate verification_key_merkle.json with proper trusted setup

Previous key had identical vk_gamma_2 and vk_delta_2, indicating unsafe
trusted setup. This commit replaces it with properly generated keys where
gamma and delta are independently sampled.

Fixes: CodeRabbit Round 6 Issue #4 (CRITICAL SECURITY)

Generated via: bun run zk:setup-all
Verified: gamma ≠ delta

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Step 5: CDN Upload (For Client-Side Proving)

### Files to Upload

Upload these files to your CDN for client-side proof generation:

```
/home/tcsenpai/kynesys/caddycdn/files/zk-circuits/v1/
├── identity_with_merkle.wasm          # Circuit WASM (from circuits/ dir)
├── identity_with_merkle_final.zkey    # Contributed proving key (from keys/ dir, renamed)
└── verification_key_merkle.json        # NEW verification key (from keys/ dir)
```

### Upload Commands

```bash
# Connect to CDN server
sftp tcsenpai@discus.sh

# Navigate to ZK circuits directory
cd /home/tcsenpai/kynesys/caddycdn/files/zk-circuits/v1

# Upload Circuit WASM (generated during compilation)
put src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm identity_with_merkle.wasm

# Upload NEW Contributed Proving Key (generated in Step 2, phase 1)
# IMPORTANT: Upload the _0001.zkey (contributed) not _0000.zkey (initial)
put src/features/zk/keys/identity_with_merkle_0001.zkey identity_with_merkle_final.zkey

# Upload NEW Verification Key (generated in Step 2)
put src/features/zk/keys/verification_key_merkle.json verification_key_merkle.json

# Verify uploads
ls -lh

# Exit SFTP
exit
```

**Expected CDN files:**
```
-rw-r--r--  identity_with_merkle.wasm          (~50-200 KB)
-rw-r--r--  identity_with_merkle_final.zkey    (~10-50 MB, from contributed phase)
-rw-r--r--  verification_key_merkle.json        (~2-5 KB)
```

**IMPORTANT**: The proving key must be from the contributed phase (_0001.zkey), not the initial phase (_0000.zkey), to ensure gamma ≠ delta security.

---

## Step 6: Update Client SDK (If Applicable)

If your SDK downloads these files from the CDN, update the SDK to point to the new files:

```typescript
// In SDK or client code
const CIRCUIT_WASM_URL = "https://your-cdn.com/zk-circuits/v1/identity_with_merkle.wasm"
const PROVING_KEY_URL = "https://your-cdn.com/zk-circuits/v1/identity_with_merkle_0000.zkey"
const VERIFICATION_KEY_URL = "https://your-cdn.com/zk-circuits/v1/verification_key_merkle.json"
```

---

## Step 7: Test End-to-End

### On Node (Verification)

```bash
# Run ZK verification tests
bun test src/features/zk/tests/

# Expected: All tests pass with NEW verification key
```

### On Client (Proof Generation)

```bash
# If you have client-side tests
# Test proof generation with NEW circuit WASM and proving key
# Test verification with NEW verification key
```

---

## Verification Checklist

Before deploying to production:

- [ ] Step 2: Keys regenerated successfully
- [ ] Step 3: Verification script confirms gamma ≠ delta
- [ ] Step 4: New verification_key_merkle.json committed to repo
- [ ] Step 5: Files uploaded to CDN at correct paths
- [ ] Step 6: SDK/client updated to use new CDN files
- [ ] Step 7: Node tests pass with new keys
- [ ] Step 7: Client proof generation works with new keys
- [ ] Coordination: All validators/nodes updated with new key from repo

---

## Rollback Plan (If Issues Arise)

If the new keys cause issues:

```bash
# Restore old (unsafe) key temporarily
cp src/features/zk/keys/verification_key_merkle.json.UNSAFE_BACKUP src/features/zk/keys/verification_key_merkle.json

# Revert CDN uploads
sftp tcsenpai@discus.sh
cd /home/tcsenpai/kynesys/caddycdn/files/zk-circuits/v1
put src/features/zk/keys/verification_key_merkle.json.UNSAFE_BACKUP verification_key_merkle.json
exit

# Re-investigate and regenerate
```

**⚠️ Note:** The old key is UNSAFE for production. Only use rollback for debugging, then fix forward.

---

## Security Notes

### Why This Matters

In Groth16 ZK-SNARKs:
- **Trusted Setup:** The ceremony generates toxic waste that must be destroyed
- **gamma and delta:** Independent parameters sampled during setup
- **Identical values:** Indicate either:
  - Broken setup process
  - Compromised setup (attacker can forge proofs)
  - Test/dummy keys never meant for production

### Single-Party vs Multi-Party Setup

**Current Approach (Single-Party):**
- ✅ Quick and simple
- ✅ You control the process
- ⚠️ Requires trust in your setup environment
- ⚠️ No external verification

**Future Enhancement (Multi-Party Ceremony):**
For maximum trustlessness, consider running a multi-party computation (MPC) ceremony where multiple independent parties contribute entropy. Even if N-1 parties are compromised, the setup remains secure.

Tools for MPC ceremonies:
- `snarkjs` supports multi-party contributions
- Coordinate with 3+ trusted entities
- Each party runs `snarkjs zkey contribute`
- Final beacon randomness for public verifiability

---

## Troubleshooting

### Issue: "circom2: command not found"

```bash
npm install -g circom2
# or
bun install -g circom2
```

### Issue: "snarkjs: command not found"

```bash
npm install -g snarkjs
# or
bun install -g snarkjs
```

### Issue: Compilation takes too long

Expected times:
- Small circuits (<100 constraints): 5-15 seconds
- Medium circuits (100-10K constraints): 15-60 seconds
- Large circuits (10K+ constraints): 1-5 minutes

If it takes longer, check system resources (CPU, RAM).

### Issue: PTAU checksum mismatch

If you encounter PTAU checksum issues, see `PTAU_CHECKSUM_FIX.md` (Issue #5).

---

## Next Steps After Completion

1. **Issue #5 (PTAU Checksum):** Decide whether to update to official Hermez checksum
2. **Issue #6b (Circuit Constraints):** Add input validation constraints to circuit
3. **Consider MPC Ceremony:** For maximum production security, plan multi-party setup

---

## Questions?

Contact: Repository maintainers
Docs: See `/docs/zk-identity-system.md` for architecture overview
