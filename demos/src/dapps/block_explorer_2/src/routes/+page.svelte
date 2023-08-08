<script>
    import demos from '$lib/demos.js';
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
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
    $:console.log(inspector);
</script>

<style>
    .card{
        border: 1px solid gainsboro;
        padding: 0 16px;
        margin: 0 0 16px;
    }
</style>

{#if inspector !== undefined}
<h1>Demos</h1>
<div class="card">
    <h2>Last Block</h2>
    <p>{lastBlockNumber} - {lastBlockHash}</p>
</div>

<div class="card">
    <h2>Block Inspector</h2>
    <p>Block number: {inspector.number}</p>
    <p>Hash: {inspector.hash}</p>
    <p>Status: {inspector.status}</p>
    <p>Transactions: {inspector.content.transactions.length}</p>
    <p>Previous hash: {inspector.content.previousHash}</p>
</div>
{:else}
<p>loading...</p>
{/if}