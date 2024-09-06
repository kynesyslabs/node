# Proof of Representation (PoR) + Byzantine Fault Tolerance (BFT) Consensus Mechanism

The PoR + BFT consensus mechanism in this system operates through a two-tier approach, combining pseudorandom-based sharding with a Byzantine Fault Tolerant voting process. Here's how it works:

1. **Initialization**: The consensus routine begins by setting the shared state to consensus mode and retrieving essential blockchain information.

2. **Validator Selection (PoR part)**: A Common Validator Selection Algorithm (CVSA) generates a deterministic seed to select a Representative Shard based on blockchain status.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 30
   endLine: 31
   ```

3. **Shard Participation Check**: Each node checks if it's part of the selected shard. Non-shard nodes wait for block broadcast.

4. **Timestamp Synchronization**: The system calculates an average timestamp from all shard nodes.

5. **Mempool Merging**: Mempools from all shard members are merged to create a common set of transactions.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 54
   endLine: 57
   ```

6. **Transaction Ordering and Block Creation**: Transactions are ordered and a new block is created.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 59
   endLine: 65
   ```

7. **Block Hash Broadcasting (BFT part)**: The hash of the new block is broadcast to all shard members, initiating the BFT voting process.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 68
   endLine: 69
   ```

8. **Vote Tallying and Consensus**: The system collects votes from shard members. Consensus is reached if the number of "pro" votes meets or exceeds a 2/3 majority plus one threshold.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 75
   endLine: 80
   ```

9. **Block Addition**: If consensus is reached, the block is added to the chain. If not, it's discarded.

   ```typescript:node/src/libs/consensus/v2/PoRBFT.ts
   startLine: 83
   endLine: 83
   ```

10. **Cleanup**: The candidate block is removed from shared state, and the last consensus time is updated.

This mechanism ensures efficient and secure block creation and validation. The PoR aspect guarantees that validators are chosen based on the current blockchain and network status, while the BFT voting process maintains Byzantine Fault Tolerance even if some nodes in the shard are faulty or malicious.