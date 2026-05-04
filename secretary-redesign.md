# Secretary Routine Redesign Proposal

## Problem

The current consensus routine uses a semaphore system with blocking phase gates where every shard member must reach the same phase before the group proceeds. The secretary node coordinates progression by collecting phase reports and broadcasting greenlights.

This creates a cascading drift problem:

- **Phase 1** (enter consensus): all nodes must enter the consensus loop simultaneously
- **Phase 2** (mempool merged): all nodes must finish N-to-N mempool merge
- **Phase 3** (voted): all nodes must finish voting

Each gate has a 30-second secretary timeout and a 60-second validator greenlight timeout. The slowest node at each gate determines the round duration. Hardware differences, RPC loads, and network conditions cause nodes to drift apart over time. Repeated timeouts stall the network as rounds restart without producing blocks.

## Proposed Flow

### Phase 1: Collect Mempools

The secretary pulls mempools from each shard member. This replaces the current N-to-N mempool merge where every node calls every other node.

- Secretary sends `getMempoolForBlock(blockRef)` to each shard member in parallel
- Each member responds with their local mempool for the given block reference
- Secretary merges, deduplicates, and validates the combined transaction set

### Phase 2: Forge and Propose

The secretary forges the block from the merged mempool and proposes it to the shard.

- Secretary creates the block
- Secretary sends `proposeBlock(block)` to each shard member

Members verify the proposal without independently forging:

- Confirm the proposer is the expected secretary for this round
- Recompute the block hash from `blockContent` and confirm it matches
- Verify the signature

If the member's checks pass, it responds with PRO and its signature over the block hash. Otherwise, it responds with CON.

### Phase 3: Commit

After collecting 2/3+1 PRO votes (signatures), the secretary broadcasts a commit message.

- Secretary sends `commitBlock(block, aggregatedValidationData)` to each shard member
- The commit includes the block and all collected signatures

### Phase 4: Finalize (Async, Per-Node)

Each node finalizes the block independently after receiving the commit.

1. Diff `ordered_transactions` against the local mempool to identify missing txs
2. Fetch missing txs from the secretary (or any shard peer that has already finalized)
3. Apply GCR edits using the full transaction data
4. Insert the block and transactions into the chain
5. Broadcast sync data update to peers

The secretary finalizes its own block and becomes ready for the next round. It does not wait for shard members to finish.
