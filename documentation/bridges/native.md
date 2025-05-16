# Native Bridges Development Notes

Status: Work in Progress

## General Logic

Native Bridges involve several steps to ensure bridge operations are properly authenticated, executed and safely managed.

The first step is to enable the client to create a `BridgeOperation` as defined in `sdks/src/bridge/nativeBridgeTypes.ts`.

Once created, the `BridgeOperation` is sent to the RPC and is managed through `src/libs/network/server_rpc.ts` that calls `src/libs/network/manageNativeBridge.ts`.

This method parse and validate the `BridgeOperation`, generating a `BridgeOperationCompiled` (defined as `NativeBridgeOperationCompiled` in the `node` repository to avoid confusion) that contains all the necessary informations for the client to properly execute the deposit.

TODO: We should ensure a malicious RPC won't steal user's funds. This will be easier on EVM as we can verify the ownership of the smart contract. Maybe on Solana we can verify the ownership of the address? In theory they both should be owned by the next shard members.

Once the client confirms the deposit by sending a specific `Transaction` through `generateOperationTx()` in `src/bridge/nativeBridge.ts`, the RPC will insert the transaction in the `Mempool` using `src/libs/network/routines/transactions/handleNativeBridgeTx.ts`.

TODO: During the consensus, the shard will verify the deposit correctness and release funds.