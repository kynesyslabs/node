<script>
    import Fa from 'svelte-fa'
    import { faArrowRightLong } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
    import { goto } from '$app/navigation';
	import Searchbar from '$lib/components/blockexplorer/HomeSearchbar.svelte';
    import demos from '$lib/demos.js';
    import { rpcaddress }  from '$lib/env.js';
	import BlockRow from '$lib/components/blockexplorer/BlockRow.svelte';
    import TimeAgo from 'javascript-time-ago';
    import en from 'javascript-time-ago/locale/en'
	import TransactionRow from '$lib/components/blockexplorer/TransactionRow.svelte';


    demos.connect(rpcaddress);
    async function getBlock() 
    {
        if(!demos.connected)
        return;
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        let block = await demos.getBlockByNumber(blockNumber.number);
        return block;
    }

    function onSearch(hash)
    {
        goto(`/blocks/${hash}`);
    }

    //helpers
    TimeAgo.addLocale(en);
    export const timeAgo = new TimeAgo('en-US');
</script>

<style>
    .container{
        max-width: 1440px;
        margin: auto;
    }
    .header-body{
        position: relative;
    }
    .subtitle{
        text-align: center;
        margin-top: 16px;
        font-family: 'Neue Machina', sans-serif;
    }

    .card{
        width: 100%;
    }
    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        border-radius: 0;
        margin: 0 0 16px;
        font-family: 'Neue Machina', sans-serif;
        font-size: 1rem;
    }
    .card-footer{
        text-align: right;
        color: white;
        font-size: 1rem;
        margin: 16px 0 0;
        font-family: 'Neue Machina', sans-serif;
    }
    .card-footer:hover{
        color: var(--accent);
        cursor: pointer;
    }
    
    .main-grid{
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-gap: 16px;
        align-items: start;
        max-width: 1440px;
        margin: auto;
    }
    .section-container{
        margin-bottom: 64px;
    }
    @media only screen and (max-width: 1250px) {
        .main-grid{
            grid-template-columns: 1fr;
        }
    }
</style>

<div class="container">
    <div>
        <div class="header-body">
            <h1>DEMOS</h1>
            <h2 class="subtitle">Block explorer</h2>
            <Searchbar prompt="Search for an hash"/>
        </div>
    </div>

    <div class="main-grid">
        <div class="section-container">
        <h4 class="card-header">Latest blocks</h4>
            <div class="card">
                {#await getBlock()}
                    <BlockRow/>
                {:then block}
                    <BlockRow block={block}/>
                {/await}
            </div>
            <a href="/blockexplorer/blocks">
                <div class="card-footer color-transition">
                    View all blocks<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
                </div>
            </a>
        </div>
        <div class="section-container">
            <h3 class="card-header">Latest transactions</h3>
            <div class="card">
                {#await getBlock()}
                    <TransactionRow/>
                {:then block}
                    {#each block.content.ordered_transactions as transaction}
                        <TransactionRow transaction={transaction}/>
                    {/each}
                {/await}
            </div>
            <a href="/blockexplorer/transactions">
                <div class="card-footer color-transition">
                    View all transactions<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
                </div>
            </a>
        </div>
    </div>
</div>