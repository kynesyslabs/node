import demos from '$lib/demos.js';
export async function load ({params})
{
    /*demos.connect(rpc);
    var lastBlockNumber;
    var lastBlockHash;
    var inspector;
    async function getLastBlockInfo(){
        demos.getLastBlockNumber().then((blockNumber) => {
            lastBlockNumber = JSON.parse(blockNumber).number;
        });
        demos.getLastBlockHash().then((blockHash) => {
            lastBlockHash = JSON.parse(blockHash).hash;
        });
        console.log( await demos.getPeerIdentity());
    }
    $: if(demos.connected){
        getLastBlockInfo();
    }
    async function inspectBlock(blockNumber)
    {
        var result;
        result = await demos.getBlockByNumber(blockNumber);
        inspector = result;
    }
    $: if(lastBlockNumber !== undefined){
        inspectBlock(lastBlockNumber);
    }
    $:console.log(inspector);*/
    const rpc = "http://85.208.48.187:53550";
    let block;
    demos.connect(rpc);
    if(demos.connected){
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        block = await demos.getBlockByNumber(blockNumber.number);
    }
    return {
        block: block
    }
}