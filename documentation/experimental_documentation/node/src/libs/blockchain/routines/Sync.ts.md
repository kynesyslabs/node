# Sync.ts

## fastSync

`export async function fastSync(
    cPeerlist: Peer[] = [],
    singlePeer: Peer = null,
)`

The fastSync function is an asynchronous function that is used to synchronize a local blockchain with the network. It takes two optional parameters: cPeerlist which is an array of peers, and singlePeer which is a single peer. If no parameters are provided, the function defaults to an empty array for cPeerlist and null for singlePeer.

The function begins by logging that it's starting the synchronization process. It then retrieves the last block number and hash from the local chain using the Chain.getLastBlockNumber and Chain.getLastBlockHash methods respectively. These values are logged for debugging purposes.

Next, the function determines the peerlist to use for the synchronization. If a singlePeer is provided, the peerlist is set to an array containing just that peer. If singlePeer is not provided, but cPeerlist is not empty, cPeerlist is used as the peerlist. If neither singlePeer nor cPeerlist are provided, the peerlist is retrieved using the peerManager.getPeers method.

The function then selects the first peer from the peerlist and makes a remote call to that peer to get the last block number. If the remote call is successful, the block number is retrieved from the response and logged. If the remote call is not successful, a message is logged indicating that the first peer does not have the last block number and the function returns true.

The function then calculates the difference between the last block number of the local chain and the last block number retrieved from the peer. This difference indicates the number of blocks that need to be synchronized.

The function then enters a loop that runs for the number of blocks that need to be synchronized. In each iteration of the loop, the function makes a remote call to the first peer to get the block by its number. The block is then parsed and its hash and previous hash are logged. The function checks if the previous hash of the retrieved block matches the hash of the last block in the local chain. If they match, the block is inserted into the local chain and the hash of the last block is updated. If they don't match, a message is logged indicating that the hash is not coherent and the loop is broken.

Finally, after all blocks have been synchronized, the function logs a success message and updates the syncStatus and inSyncLoop properties of the shared state to indicate that the synchronization process is complete.