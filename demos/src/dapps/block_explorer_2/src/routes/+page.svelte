<script>
    import demos from '$lib/demos.js';
    import Fa from 'svelte-fa'
    import { faArrowRightLong, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
	import Footer from '$lib/components/Footer.svelte';
    /*const rpc = "http://85.208.48.187:53550";
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
    $:console.log(inspector);*/

    const placeholderBlocks = [
        {
            number: 17876204,
            age: "7 secs ago",
            recipient:"rsync-builder",
            txns: 120,
            time:1200,
            reward: 0.0392
        },
        {
            number:17876203,
            age:"19 secs ago",
            recipient:"beaverbuild",
            txns: 121,
            time:1200,
            reward: 0.06049
        },
        {
            number:17876202,
            age:"31 secs ago",
            recipient:"Lido: Execution Layer R...",
            txns: 121,
            time:1200,
            reward: 0.0185
        },
        {
            number:17876201,
            age:"43 secs ago",
            recipient:"beaverbuild",
            txns: 125,
            time:1200,
            reward: 0.02033
        },
        {
            number:17876200,
            age:"55 secs ago",
            recipient:"0xcDBF58...dE858321",
            txns: 118,
            time:1200,
            reward: 0.05657
        },
        {
            number:17876199,
            age:"1 min ago",
            recipient:"0x0dE858...cDBF58",
            txns: 120,
            time:1200,
            reward: 0.0304
        }
    ]

    const placeholderTransactions = [
        {
            hash: "0x09db1cdc348631e0...",
            age: "7 secs ago",
            from:"0x1f9090...e676c326",
            to: "0xeBec79...F299cAcf",
            amount:0.0322,
        },
        {
            hash:"0xcef8eb661221ff533...",
            age:"7 secs ago",
            from:"0xB8782E...052A4Bb9",
            to: "0x7a250d...59F2488D",
            amount:0,
        },
        {
            hash:"0x97cde7911e5d60f9aacc...",
            age:"7 secs ago",
            from:"0x0C9F04...a3c599DF",
            to: "0x3fC91A...4B2b7FAD",
            amount:0.022,
        },
        {
            hash:"0xf9b1304659b79dd1a60b...",
            age:"7 secs ago",
            from:"0x10f3Ee...D35c865f",
            to: "0xdAC17F...3D831ec7",
            amount:0,
        },
        {
            hash:"0x16016b60ced0971151...",
            age:"7 secs ago",
            from:"0x8cd848...b37b35dd",
            to: "0xdAC17F...3D831ec7",
            amount:0,
        },
        {
            hash:"0x4d0fbca9f9b58337c...",
            age:"7 secs ago",
            from:"0x272c3c...86EbfADf",
            to: "0x490480...AF74E97e",
            amount:0.0023,
        }
    ]
</script>

<style>
    
    .subtitle{
        text-align: center;
        margin-top: 0;
        font-family: 'Neue Machina', sans-serif;
    }
    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: #252525;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
    }
    .card-footer:hover{
        color: var(--accent);
        cursor: pointer;
    }
    .logo{
        border-radius: 50%;
        width: 100px;
        margin: 16px;
    }
    .label{
        margin-bottom: 8px;
        opacity: .75;
        text-align: center;
        font-size: 1rem;
    }
    .inputContainer{
        width: 500px;
        max-width: 100%;
        margin: 32px auto;
        position: relative;
        top: 24px;
    }
    .inputButton{
        background-color: var(--accent);
        position: absolute;
        right: 8px;
        top: 32px;
        border: none;
        font-size: 1.4rem;
        color: white;
        border-radius: var(--border-radius);
    }
    .main-grid{
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-gap: 16px;
        padding: 16px;
        align-items: start;
    }
    .block-card{
        display: grid;
        grid-template-columns: 55px auto 1fr 100px;
        padding: 16px;
        border-bottom: 1px solid var(--border-color);
        gap: 16px;
    }
    .block-icon-container{
        width:55px;
        height: 45px;
        background-color: #404040;
        border-radius: var(--border-radius);
        display: flex;
        justify-content: center;
        align-items: center;
    }
    .block-icon{
        filter: invert();
        width: 35px;
    }
    .generic-shadow{
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
    }
    .reward-container{
        display:flex;
        justify-content: center;
        align-items: center;
        border: 1px solid #404040;
        border-radius: var(--border-radius);
        align-self: center;
    }
    .reward{
        font-size: .8rem;
        margin: 8px;
    }

</style>


<div class="container">
    <div style="background:url('/poster.jpg');background-position:center;">
        <img alt="logo" class="logo" src="/logo.jpg"/>
        <h1>Demos</h1>
        <h2 class="subtitle">Block explorer</h2>
        <div class="inputContainer">
            <p class="label">Search by hash</p>
            <input placeholder=""/>
            <button class="inputButton"><Fa icon={faMagnifyingGlass}></Fa></button>
        </div>
    </div>

<div class="main-grid">

    <div class="card generic-shadow">
        <h4 class="card-header">Latest blocks</h4>
        {#each placeholderBlocks as block}
            <div class="block-card">
                <div class="block-icon-container generic-shadow">
                    <img class="block-icon" alt="Block icon" src="/icons/cube-icon.png"/>
                </div>
                <div style="width: 100px;">
                    <p class="fake-link" style="margin-top:0;margin-bottom:8px;">{block.number}</p>
                    <p style="margin: 0; opacity:.5; font-size:.9rem;">{block.age}</p>
                </div>
                <div>
                    <p style="margin-top:0;margin-bottom:8px;">Fee recipient <span class="fake-link">{block.recipient}</span></p>
                    <p style="margin: 0;font-size:.9rem;"><span class="fake-link">{block.txns} txns</span> <span style="opacity:.5">{block.time/100} secs</span></p>
                </div>
                <div class="reward-container generic-shadow">
                    <p class="reward" style="font-size:.8rem">{block.reward} DEM</p>
                </div>
            </div>
        {/each}
        <div class="card-footer">
            View all blocks<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
        </div>
    </div>
    <div class="card">
        <h4 class="card-header">Latest transactions</h4>
        {#each placeholderTransactions as transaction}
        <div class="block-card">
            <div class="block-icon-container generic-shadow">
                <img class="block-icon" alt="Block icon" src="/icons/agreement-icon.png"/>
            </div>
            <div style="width: 200px;">
                <p class="fake-link" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p>
                <p style="margin: 0; opacity:.5; font-size:.9rem;">{transaction.age}</p>
            </div>
            <div>
                <p style="margin-top:0;margin-bottom:8px;">From <span class="fake-link">{transaction.from}</span></p>
                <p style="margin: 0;">To <span class="fake-link">{transaction.to}</span></p>
            </div>
            <div class="reward-container generic-shadow">
                <p class="reward" style="font-size:.8rem">{transaction.amount} DEM</p>
            </div>
        </div>
        {/each}
        <div class="card-footer">
            View all transactions<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
        </div>
    </div>

    <!--<div class="card">
        <h2>Block Inspector</h2>
        <p>Block number: {inspector.number}</p>
        <p>Hash: {inspector.hash}</p>
        <p>Status: {inspector.status}</p>
        <p>Transactions: {inspector.content.transactions.length}</p>
        <p>Previous hash: {inspector.content.previousHash}</p>
    </div>-->

</div>

<Footer/>

</div>
<!--{#if inspector !== undefined}
<div></div>
{:else}
<p>loading...</p>
{/if}-->