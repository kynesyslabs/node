/* eslint-disable no-constant-condition */ /* eslint-disable no-undef */ // Registering GUI components
let rpcUrl = document.getElementById("rpcUrl");
let latestBlocks = document.getElementById("latestBlocks");
let blockInspector = document.getElementById("blockInspector");
// TODO Listener for a href block_*
var rpc = "http://85.208.48.187:53550";
// NOTE Called by the watchdog dynamically
// eslint-disable-next-line no-unused-vars
async function inspectBlock(block_number) {
    let block_content = await demos.getBlockByNumber(block_number) // Getting the block content continuously
    ;
    blockInspector.innerHTML = JSON.stringify(block_content, null, 2) // Converting the block content to a string
    ;
}
async function watchdog() {
    let peer_identity = null;
    while(true){
        await sleep(2000);
        if (demos.connected) {
            if (!peer_identity) {
                peer_identity = await demos.getPeerIdentity() // Getting the peer identity
                ;
                peer_identity = peer_identity.replace("I am ", "");
                console.log(peer_identity);
                // NOTE Adding this to the GUI as an example
                rpcUrl.innerHTML = rpcUrl.innerHTML + "\n" + peer_identity;
            }
            let last_number = await demos.getLastBlockNumber() // Getting the last block number continuously
            ;
            console.log(last_number);
            let last_hash = await demos.getLastBlockHash() // Getting the last block hash continuously
            ;
            console.log(last_hash);
            // NOTE Adding this to the GUI as an example
            latestBlocks.innerHTML = '<p class="lineblock"> ' + JSON.parse(last_number).number + " - " + "<a href=\"javascript:inspectBlock('" + JSON.parse(last_number).number + "')\">" + JSON.parse(last_hash).hash + "</a>" + "</p>";
        }
    }
}
async function main() {
    console.log(demos);
    // Setting GUI elements
    rpcUrl.innerHTML = rpc;
    console.log("[DEMOS] Loading...");
    demos.connect(rpc);
    watchdog();
}
main();

//# sourceMappingURL=index.44983732.js.map
