pragma circom 2.1.0;

include "bitify.circom";
include "comparators.circom";
include "poseidon.circom";

/*
 * L2PS settlement: the net change per account of a batch is exactly the
 * result of applying the signed transfers behind its commitments, in batch
 * order, with no overdraft and no overflow.
 * Spec: docs/design/l2ps-zk-settlement.md, "Circuit" and "Interface v1.1".
 *
 * The statement's values (Interface v1's 1 + 5N + 6M signals) are private;
 * the one public input is a Poseidon sponge over them, which the verifier
 * recomputes from its own values. One public input keeps the proving key
 * small and the prover off the per-input Lagrange work.
 *
 * Every value that enters the balance arithmetic is below 2^130, far from
 * the field order, so integer and field arithmetic agree wherever a range
 * check draws a conclusion from them. Witness values and running balances
 * are range-checked here; balances before the batch and net change
 * magnitudes are hashed as whole field elements, so they are exactly the
 * verifier's values, which it accepts only below 2^128.
 */

// x is a bit.
template AssertBit() {
    signal input in;
    in * (in - 1) === 0;
}

// in is in [0, 2^n).
template RangeCheck(n) {
    signal input in;
    component bits = Num2Bits(n);
    bits.in <== in;
}

// One-hot selector of index over [0, size) when enable is 1, all zero when
// it is 0: an index outside the range has no witness, and a disabled
// selector forces index to 0.
template GatedSelector(size) {
    signal input index;
    signal input enable;
    signal output sel[size];
    var total = 0;
    var position = 0;
    for (var j = 0; j < size; j++) {
        sel[j] <-- (enable == 1 && index == j) ? 1 : 0;
        sel[j] * (sel[j] - 1) === 0;
        total += sel[j];
        position += j * sel[j];
    }
    total === enable;
    position === index;
}

// Sum of sel[j] * values[j].
template Select(size) {
    signal input sel[size];
    signal input values[size];
    signal output out;
    signal prod[size];
    var total = 0;
    for (var j = 0; j < size; j++) {
        prod[j] <== sel[j] * values[j];
        total += prod[j];
    }
    out <== total;
}

template L2PSSettlement(N, M) {
    // The statement, in the order of Interface v1 except the signer limbs,
    // which are the sender account's limbs (bound through senderIndex).
    signal input commitmentsHash;
    signal input transferActive[N];
    signal input nonce[N];
    signal input fee[N];
    signal input accountActive[M];
    signal input accountHi[M];
    signal input accountLo[M];
    signal input balanceBefore[M];
    signal input deltaNegative[M];
    signal input deltaMagnitude[M];
    // The only public input: settlementPublicHash of the statement.
    signal input publicHash;

    // Witness only.
    signal input toHi[N];
    signal input toLo[N];
    signal input amount[N];
    signal input salt[N];
    signal input senderIndex[N];
    signal input receiverIndex[N];

    // ---- Transfer slots: active prefix, inactive slots all zero ----
    // A batch has at least one transfer; the active flags come first so the
    // validator's transfer count fixes them.
    transferActive[0] === 1;
    component transferBit[N];
    signal transferIdle[N];
    for (var i = 0; i < N; i++) {
        transferBit[i] = AssertBit();
        transferBit[i].in <== transferActive[i];
        if (i > 0) {
            transferActive[i] * (1 - transferActive[i - 1]) === 0;
        }
        transferIdle[i] <== 1 - transferActive[i];
        // Indices and receiver limbs of an idle slot are forced to 0 by the
        // selectors below, which are gated by the active flag.
        nonce[i] * transferIdle[i] === 0;
        fee[i] * transferIdle[i] === 0;
        amount[i] * transferIdle[i] === 0;
        salt[i] * transferIdle[i] === 0;
    }

    // ---- Account slots: active prefix, inactive slots all zero ----
    component accountBit[M];
    component negativeBit[M];
    signal accountIdle[M];
    for (var j = 0; j < M; j++) {
        accountBit[j] = AssertBit();
        accountBit[j].in <== accountActive[j];
        if (j > 0) {
            accountActive[j] * (1 - accountActive[j - 1]) === 0;
        }
        accountIdle[j] <== 1 - accountActive[j];
        accountHi[j] * accountIdle[j] === 0;
        accountLo[j] * accountIdle[j] === 0;
        balanceBefore[j] * accountIdle[j] === 0;
        deltaNegative[j] * accountIdle[j] === 0;
        deltaMagnitude[j] * accountIdle[j] === 0;
        negativeBit[j] = AssertBit();
        negativeBit[j].in <== deltaNegative[j];
    }

    // ---- Range checks ----
    // The running balances and the delta equation reason about integers; they
    // hold only while every operand is a small non-negative integer. A fee
    // written as p - x would otherwise read as a negative number. The fee and
    // nonce ranges also keep their packed public hash element injective.
    // Balances before the batch, magnitudes and account limbs are hashed
    // whole and range-checked by the verifier; the ordering below keeps
    // accounts unique for any limbs.
    component amountRange[N];
    component feeRange[N];
    component nonceRange[N];
    for (var i = 0; i < N; i++) {
        amountRange[i] = RangeCheck(128);
        amountRange[i].in <== amount[i];
        feeRange[i] = RangeCheck(128);
        feeRange[i].in <== fee[i];
        nonceRange[i] = RangeCheck(64);
        nonceRange[i].in <== nonce[i];
    }

    // ---- Accounts strictly increasing by (hi, lo) ----
    // Unique accounts: one balance cannot be spent twice from two slots.
    // Compare lo when the hi limbs are equal, hi otherwise; next - this - 1
    // in [0, 2^128) is next > this for 128-bit operands. Uniqueness holds for
    // any limbs: along the active prefix each hi step adds at most 2^128 to
    // the previous hi, so 19 steps cannot wrap around the field to an earlier
    // hi unless every step between was 0, and then the lo steps (each in
    // [1, 2^128]) keep the lo limbs apart the same way.
    component hiEqual[M - 1];
    signal thisKey[M - 1];
    signal nextKey[M - 1];
    signal gap[M - 1];
    component gapRange[M - 1];
    for (var j = 0; j < M - 1; j++) {
        hiEqual[j] = IsEqual();
        hiEqual[j].in[0] <== accountHi[j];
        hiEqual[j].in[1] <== accountHi[j + 1];
        thisKey[j] <== accountHi[j] + hiEqual[j].out * (accountLo[j] - accountHi[j]);
        nextKey[j] <== accountHi[j + 1] + hiEqual[j].out * (accountLo[j + 1] - accountHi[j + 1]);
        gap[j] <== accountActive[j + 1] * (nextKey[j] - thisKey[j] - 1);
        gapRange[j] = RangeCheck(128);
        gapRange[j].in <== gap[j];
    }

    // ---- Sender and receiver selection ----
    // Selectors are gated by the active flag, so an idle slot selects nothing.
    // An active slot must select an active account for its sender and one
    // whose limbs are the committed receiver's. The sender's limbs open the
    // commitment and senderIndex is in the public hash, so the signer the
    // validator checked the signature of is the account debited.
    component senderSel[N];
    component receiverSel[N];
    signal senderPick[N][M];
    signal receiverPick[N][M];
    component senderActive[N];
    component receiverActive[N];
    component senderHi[N];
    component senderLo[N];
    component receiverHi[N];
    component receiverLo[N];
    for (var i = 0; i < N; i++) {
        senderSel[i] = GatedSelector(M);
        senderSel[i].index <== senderIndex[i];
        senderSel[i].enable <== transferActive[i];
        receiverSel[i] = GatedSelector(M);
        receiverSel[i].index <== receiverIndex[i];
        receiverSel[i].enable <== transferActive[i];
        for (var j = 0; j < M; j++) {
            senderPick[i][j] <== senderSel[i].sel[j];
            receiverPick[i][j] <== receiverSel[i].sel[j];
        }

        senderActive[i] = Select(M);
        receiverActive[i] = Select(M);
        senderHi[i] = Select(M);
        senderLo[i] = Select(M);
        receiverHi[i] = Select(M);
        receiverLo[i] = Select(M);
        for (var j = 0; j < M; j++) {
            senderActive[i].sel[j] <== senderPick[i][j];
            senderActive[i].values[j] <== accountActive[j];
            receiverActive[i].sel[j] <== receiverPick[i][j];
            receiverActive[i].values[j] <== accountActive[j];
            senderHi[i].sel[j] <== senderPick[i][j];
            senderHi[i].values[j] <== accountHi[j];
            senderLo[i].sel[j] <== senderPick[i][j];
            senderLo[i].values[j] <== accountLo[j];
            receiverHi[i].sel[j] <== receiverPick[i][j];
            receiverHi[i].values[j] <== accountHi[j];
            receiverLo[i].sel[j] <== receiverPick[i][j];
            receiverLo[i].values[j] <== accountLo[j];
        }
        senderActive[i].out === transferActive[i];
        receiverActive[i].out === transferActive[i];
        receiverHi[i].out === toHi[i];
        receiverLo[i].out === toLo[i];
    }

    // ---- Every active account is touched by an active transfer ----
    // The account list is then exactly the touched set, so a batch cannot
    // name accounts it does not move.
    component untouched[M];
    for (var j = 0; j < M; j++) {
        var touches = 0;
        for (var i = 0; i < N; i++) {
            touches += senderPick[i][j] + receiverPick[i][j];
        }
        untouched[j] = IsZero();
        untouched[j].in <== touches;
        accountActive[j] * untouched[j].out === 0;
    }

    // ---- Commitment openings ----
    // The validator hashes the signed commitments it received, idle slots 0,
    // so the proof covers exactly the transfers the senders signed.
    component commitment[N];
    signal slotCommitment[N];
    component batchHash = Poseidon(N);
    for (var i = 0; i < N; i++) {
        commitment[i] = Poseidon(8);
        commitment[i].inputs[0] <== senderHi[i].out;
        commitment[i].inputs[1] <== senderLo[i].out;
        commitment[i].inputs[2] <== toHi[i];
        commitment[i].inputs[3] <== toLo[i];
        commitment[i].inputs[4] <== amount[i];
        commitment[i].inputs[5] <== fee[i];
        commitment[i].inputs[6] <== nonce[i];
        commitment[i].inputs[7] <== salt[i];
        slotCommitment[i] <== commitment[i].out * transferActive[i];
        batchHash.inputs[i] <== slotCommitment[i];
    }
    batchHash.out === commitmentsHash;

    // ---- Running balances in batch order ----
    // Each transfer debits amount + fee from the sender, then credits amount
    // to the receiver; only the touched account changes, and its new value is
    // range-checked, so every running balance stays in [0, 2^128) by
    // induction from the balances before the batch, which are below 2^128. A
    // self-transfer must afford the debit before its own credit.
    signal balance[N + 1][M];
    signal afterDebit[N][M];
    signal debitApplied[N][M];
    signal creditApplied[N][M];
    component senderAfter[N];
    component receiverAfter[N];
    component senderAfterRange[N];
    component receiverAfterRange[N];
    for (var j = 0; j < M; j++) {
        balance[0][j] <== balanceBefore[j];
    }
    for (var i = 0; i < N; i++) {
        senderAfter[i] = Select(M);
        receiverAfter[i] = Select(M);
        for (var j = 0; j < M; j++) {
            debitApplied[i][j] <== senderPick[i][j] * (amount[i] + fee[i]);
            afterDebit[i][j] <== balance[i][j] - debitApplied[i][j];
            senderAfter[i].sel[j] <== senderPick[i][j];
            senderAfter[i].values[j] <== afterDebit[i][j];
        }
        senderAfterRange[i] = RangeCheck(128);
        senderAfterRange[i].in <== senderAfter[i].out;
        for (var j = 0; j < M; j++) {
            creditApplied[i][j] <== receiverPick[i][j] * amount[i];
            balance[i + 1][j] <== afterDebit[i][j] + creditApplied[i][j];
            receiverAfter[i].sel[j] <== receiverPick[i][j];
            receiverAfter[i].values[j] <== balance[i + 1][j];
        }
        receiverAfterRange[i] = RangeCheck(128);
        receiverAfterRange[i].in <== receiverAfter[i].out;
    }

    // ---- Net change per account ----
    // after - before = (1 - 2 * negative) * magnitude. With magnitude below
    // 2^128 (the verifier's value) and both balances in [0, 2^128) the
    // equation holds over the integers, and magnitude 0 has one encoding (not
    // negative).
    component zeroMagnitude[M];
    signal negativeMagnitude[M];
    for (var j = 0; j < M; j++) {
        zeroMagnitude[j] = IsZero();
        zeroMagnitude[j].in <== deltaMagnitude[j];
        deltaNegative[j] * zeroMagnitude[j].out === 0;
        negativeMagnitude[j] <== deltaNegative[j] * deltaMagnitude[j];
        balance[N][j] - balanceBefore[j] === deltaMagnitude[j] - 2 * negativeMagnitude[j];
    }

    // ---- Public hash ----
    // Interface v1.1: the statement packed into 2 + N + 4M field elements and
    // absorbed 7 at a time, h = Poseidon8(h, e[7k .. 7k + 6]) from h = 0, the
    // last chunk padded with zeros:
    //   commitmentsHash,
    //   per transfer: fee + nonce * 2^128 + senderIndex * 2^192
    //                 + transferActive * 2^200,
    //   per account: hi, lo, balanceBefore, deltaMagnitude,
    //   sum over accounts of accountActive * 4^j + deltaNegative * 2 * 4^j.
    // The packing is injective because fee < 2^128 and nonce < 2^64 are
    // range-checked, senderIndex < M <= 126 by its selector, and the flags
    // are bits.
    assert(M <= 126);
    var E = 2 + N + 4 * M;
    var CHUNKS = (E + 6) \ 7;
    signal packed[CHUNKS * 7];
    packed[0] <== commitmentsHash;
    for (var i = 0; i < N; i++) {
        packed[1 + i] <== fee[i] + nonce[i] * (1 << 128) + senderIndex[i] * (1 << 192) + transferActive[i] * (1 << 200);
    }
    var flags = 0;
    for (var j = 0; j < M; j++) {
        packed[1 + N + 4 * j] <== accountHi[j];
        packed[1 + N + 4 * j + 1] <== accountLo[j];
        packed[1 + N + 4 * j + 2] <== balanceBefore[j];
        packed[1 + N + 4 * j + 3] <== deltaMagnitude[j];
        flags += accountActive[j] * (1 << (2 * j)) + deltaNegative[j] * (1 << (2 * j + 1));
    }
    packed[1 + N + 4 * M] <== flags;
    for (var k = E; k < CHUNKS * 7; k++) {
        packed[k] <== 0;
    }
    component sponge[CHUNKS];
    for (var c = 0; c < CHUNKS; c++) {
        sponge[c] = Poseidon(8);
        sponge[c].inputs[0] <== c == 0 ? 0 : sponge[c - 1].out;
        for (var k = 0; k < 7; k++) {
            sponge[c].inputs[1 + k] <== packed[7 * c + k];
        }
    }
    sponge[CHUNKS - 1].out === publicHash;
}

// N = SETTLEMENT_TRANSFERS and M = SETTLEMENT_ACCOUNTS of
// src/libs/l2ps/settlement/encoding.ts.
component main {public [publicHash]} = L2PSSettlement(9, 18);
