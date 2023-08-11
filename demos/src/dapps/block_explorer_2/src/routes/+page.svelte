<script>
    import demos from '$lib/demos.js';
    import Fa from 'svelte-fa'
    import { faArrowRightLong } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
	import Footer from '$lib/components/Footer.svelte';
	import Header from '$lib/components/Header.svelte';
    export let data;
    const latestBlocks = [data.block];
    console.log(data);

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
    
    .main-grid{
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-gap: 16px;
        padding: 16px;
        align-items: start;
    }
    @media only screen and (max-width: 1250px) {
        .main-grid{
            grid-template-columns: 1fr;
        }
    }
    .block-card{
        display: grid;
        grid-template-columns: auto 1fr 100px;
        padding: 16px;
        border-bottom: 1px solid var(--border-color);
        gap: 16px;
    }
    .block-card-header{
        display: flex;
        gap: 16px;
        align-items: center;
    }
    @media only screen and (max-width:650px) {
        .block-card{
            grid-template-columns: 1fr;
        }
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

<Header/>

<div class="main-grid">

    <div class="card generic-shadow">
        <h4 class="card-header">Latest blocks</h4>
        {#each latestBlocks as block}
            <div class="block-card">
                <div class="block-card-header">
                    <div class="block-icon-container generic-shadow">
                        <img class="block-icon" alt="Block icon" src="/icons/cube-icon.png"/>
                    </div>
                    <div style="width: 100px;">
                        <a class="accessible" href={`/blocks/${block.number}`}><p style="margin-top:0;margin-bottom:8px;">{block.number}</p></a>
                        <p style="margin: 0; opacity:.5; font-size:.9rem;">{block.timestamp}</p>
                    </div>
                </div>
                <div>
                    <p style="margin-top:0;margin-bottom:8px;">Proposer <span class="fake-link">{block.proposer}</span></p>
                    <a class="accessible" href={`/blocks/${block.number}#transactions`}><p style="margin: 0;font-size:.9rem;"><span>{block.content.transactions.length} transactions</span><!--<span style="opacity:.5"> {block.time/100} secs</span>--></p></a>
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
            <div class="block-card-header">
                <div class="block-icon-container generic-shadow">
                    <img class="block-icon" alt="Block icon" src="/icons/agreement-icon.png"/>
                </div>
                <div style="width: 200px;">
                    <p class="fake-link" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p>
                    <p style="margin: 0; opacity:.5; font-size:.9rem;">{transaction.age}</p>
                </div>
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