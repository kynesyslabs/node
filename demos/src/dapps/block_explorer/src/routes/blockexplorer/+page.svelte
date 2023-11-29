<script>
    import Fa from 'svelte-fa'
    import { faArrowRightLong } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
    import { goto } from '$app/navigation';
	import Searchbar from './HomeSearchbar.svelte';
    import demos from '$lib/demos.js';
    import { rpcaddress }  from '$lib/env.js';
	import BlockRow from './BlockRow.svelte';
    import TimeAgo from 'javascript-time-ago';
    import en from 'javascript-time-ago/locale/en'
	import TransactionRow from './TransactionRow.svelte';
    import PageTitle from '$lib/components/PageTitle.svelte';


    demos.connect($rpcaddress);
    async function getBlock() 
    {
        if(!demos.connected)
        return;
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        let block = await demos.getBlockByNumber(blockNumber);
        block.content = JSON.parse(block.content);
        return block;
    }

    async function getBlocks() 
    {
        let blockRequests = [];
        if(!demos.connected)
        return;
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        for(let i = blockNumber; i > Math.max(blockNumber - 10, 0); i--)
        {   
            blockRequests.push(demos.getBlockByNumber(i));
        }
        console.log("blockRequests", blockRequests);
        let blockValues = await Promise.all(blockRequests);
        try{
            blockValues.forEach(block=>{
                block.content = JSON.parse(block.content);
            })
        }  
        catch(e)
        {
            console.log("parse error", e);
        }
        console.log("blockValues", blockValues);
        return blockValues;
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
        margin-top: 50px;
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
        font-family: 'SourceCodePro', sans-serif;
    }
    .card-footer{
        text-align: right;
        color: var(--color);
        margin: 16px 0 0;
        font-family: 'SourceCodePro', sans-serif;
    }
    .card-footer:hover{
        color: var(--color2);
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
        margin-top: 64px;
        margin-bottom: 64px;
    }
    @media only screen and (max-width: 1250px) {
        .main-grid{
            grid-template-columns: 1fr;
        }
    }

    .error-card{
        padding: 24px;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 16px;
        opacity: .5;
        align-items: center;
    }
</style>

<div class="container">
    <div>
        <div class="header-body">
            <!--<img src="/logo/Logo DEMOS White.svg" alt="Logo DEMOS" width="240px" style="display:block; margin:auto;"/>-->
            <PageTitle>Block Explorer</PageTitle>
            <h4 class="subtitle">Discover Blocks and Transactions on the DEMOS Network</h4>
            <Searchbar prompt="Search for a hash"/>
        </div>
    </div>

    <div class="main-grid">
        <div class="section-container">
        <h4 class="card-header">Latest Blocks</h4>
            <div class="card">
                {#await getBlocks()}
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                    <BlockRow/>
                {:then blocks}
                    {#if blocks.length > 0}
                        {#each blocks as block}
                            <BlockRow block={block}/>
                        {/each}
                    {:else}
                        <div class="error-card">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="40" height="40"><g id="warning-triangle--frame-alert-warning-triangle-exclamation-caution"><path id="Subtract" fill="var(--color)" fill-rule="evenodd" d="m12 1.5-11 21h22l-11-21ZM11 16v-6h2v6h-2Zm0 2v2h2v-2h-2Z" clip-rule="evenodd"></path></g></svg>
                            <p>No block found in this node</p>
                        </div>
                    {/if}
                {:catch error}
                    <div class="error-card">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="40" height="40"><g id="warning-triangle--frame-alert-warning-triangle-exclamation-caution"><path id="Subtract" fill="var(--color)" fill-rule="evenodd" d="m12 1.5-11 21h22l-11-21ZM11 16v-6h2v6h-2Zm0 2v2h2v-2h-2Z" clip-rule="evenodd"></path></g></svg>
                        <p>Something went wrong</p>
                    </div>
                {/await}
            </div>
            <a href="/blockexplorer/blocks">
                <div class="card-footer color-transition">
                    View all blocks<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
                </div>
            </a>
        </div>
        <div class="section-container">
            <h4 class="card-header">Latest Transactions</h4>
            <div class="card">
                {#await getBlock()}
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                    <TransactionRow/>
                {:then block}
                    {#if block.content.ordered_transactions.length > 0}
                        {#each block.content.ordered_transactions as transaction}
                            <TransactionRow transaction={transaction}/>
                        {/each}
                    {:else}
                    <div class="error-card">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="40" height="40"><g id="warning-triangle--frame-alert-warning-triangle-exclamation-caution"><path id="Subtract" fill="var(--color)" fill-rule="evenodd" d="m12 1.5-11 21h22l-11-21ZM11 16v-6h2v6h-2Zm0 2v2h2v-2h-2Z" clip-rule="evenodd"></path></g></svg>
                        <p>No transaction found in the last block</p>
                    </div>
                    {/if}
                {:catch error}
                    <div class="error-card">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="40" height="40"><g id="warning-triangle--frame-alert-warning-triangle-exclamation-caution"><path id="Subtract" fill="var(--color)" fill-rule="evenodd" d="m12 1.5-11 21h22l-11-21ZM11 16v-6h2v6h-2Zm0 2v2h2v-2h-2Z" clip-rule="evenodd"></path></g></svg>
                        <p>Something went wrong</p>
                    </div>
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