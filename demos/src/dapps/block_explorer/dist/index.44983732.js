/* eslint-disable no-constant-condition */ /* eslint-disable no-undef */ // Registering GUI components
let rpcUrl = document.getElementById("rpcUrl");
let latestBlocks = document.getElementById("latestBlocks");
var rpc = "http://localhost:53550";
async function watchdog() {
    while(true){
        await sleep(1000);
        if (connected) nodeCall("getLatestBlocks");
    }
}
async function main() {
    // Setting GUI elements
    rpcUrl.innerHTML = rpc;
    console.log("[DEMOS] Loading...");
    connect(rpc);
    watchdog();
}
main();

//# sourceMappingURL=index.44983732.js.map
