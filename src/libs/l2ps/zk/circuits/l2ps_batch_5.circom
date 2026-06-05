pragma circom 2.1.0;

include "bitify.circom";
include "poseidon.circom";

/*
 * L2PS Batch Circuit - 5 transactions
 * ~17K constraints → pot15 (32MB)
 * 
 * For batches with 1-5 transactions.
 * Unused slots filled with zero-amount transfers.
 */

template BalanceTransfer() {
    signal input sender_before;
    signal input sender_after;
    signal input receiver_before;
    signal input receiver_after;
    signal input amount;
    
    signal output pre_hash;
    signal output post_hash;
    
    sender_after === sender_before - amount;
    receiver_after === receiver_before + amount;

    // SECURITY FIX — range checks on every magnitude that can cause a
    // BN254 field-wrap. Without these an overdraw makes `sender_after`
    // wrap to a value about the size of the curve order and the proof
    // still accepts; same for a `receiver_after` overflow or an
    // oversized `amount`. Mirrors the guard already present on batch-10
    // — propagated here in DEM-756 / PATH-OS L2PS hardening report
    // item 5. 64 bits is the user-balance limit.
    component senderAfterRange = Num2Bits(64);
    senderAfterRange.in <== sender_after;

    component receiverAfterRange = Num2Bits(64);
    receiverAfterRange.in <== receiver_after;

    component amountRange = Num2Bits(64);
    amountRange.in <== amount;

    component preHasher = Poseidon(2);
    preHasher.inputs[0] <== sender_before;
    preHasher.inputs[1] <== receiver_before;
    pre_hash <== preHasher.out;
    
    component postHasher = Poseidon(2);
    postHasher.inputs[0] <== sender_after;
    postHasher.inputs[1] <== receiver_after;
    post_hash <== postHasher.out;
}

template L2PSBatch(batch_size) {
    signal input initial_state_root;
    signal input final_state_root;
    signal input total_volume;
    
    signal input sender_before[batch_size];
    signal input sender_after[batch_size];
    signal input receiver_before[batch_size];
    signal input receiver_after[batch_size];
    signal input amounts[batch_size];
    
    component transfers[batch_size];
    component stateChain[batch_size];
    
    signal state_hashes[batch_size + 1];
    state_hashes[0] <== initial_state_root;
    
    signal volume_acc[batch_size + 1];
    volume_acc[0] <== 0;
    
    for (var i = 0; i < batch_size; i++) {
        transfers[i] = BalanceTransfer();
        
        transfers[i].sender_before <== sender_before[i];
        transfers[i].sender_after <== sender_after[i];
        transfers[i].receiver_before <== receiver_before[i];
        transfers[i].receiver_after <== receiver_after[i];
        transfers[i].amount <== amounts[i];
        
        stateChain[i] = Poseidon(2);
        stateChain[i].inputs[0] <== state_hashes[i];
        stateChain[i].inputs[1] <== transfers[i].post_hash;
        state_hashes[i + 1] <== stateChain[i].out;
        
        volume_acc[i + 1] <== volume_acc[i] + amounts[i];
    }
    
    final_state_root === state_hashes[batch_size];
    total_volume === volume_acc[batch_size];
}

component main {public [initial_state_root, final_state_root, total_volume]} = L2PSBatch(5);
