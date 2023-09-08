<script>
    import Fa from 'svelte-fa'
    import { faArrowRightLong } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
    export let data;
    const latestBlocks = [data.block];
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import transIcon from '$lib/assets/icons/agreement-icon.png';
    import { goto } from '$app/navigation';

    import TimeAgo from 'javascript-time-ago'

    // English.
    import en from 'javascript-time-ago/locale/en'
	import Searchbar from '$lib/components/blockexplorer/HomeSearchbar.svelte';
	import Card from '$lib/components/surfaces/Card.svelte';

    TimeAgo.addLocale(en);

    // Create formatter (English).
    const timeAgo = new TimeAgo('en-US')

    console.log(data);

    function onSearch(hash)
    {
        goto(`/blocks/${hash}`);
    }
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
    @media only screen and (max-width: 1250px) {
        .main-grid{
            grid-template-columns: 1fr;
        }
    }
    .block-card{
        display: grid;
        grid-template-columns: auto 1fr 100px;
        border-bottom: 1px solid var(--border-color);
        gap: 16px;
        padding: 32px 16px;
        border-bottom: 2px solid black;
    }
    .block-cell{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
        border-radius: var(--border-radius);
        display: flex;
        justify-content: center;
        align-items: center;
    }
    .block-icon{
        filter: invert();
        width: 40px;
    }
    .generic-shadow{
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
    }
    .reward-container{
        display:flex;
        justify-content: center;
        align-items: center;
        align-self: center;
    }
    .reward{
        font-size: .8rem;
        margin: 8px;
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
        <div>
        <h4 class="card-header">Latest blocks</h4>
            <div class="card">
                {#each latestBlocks as block}
                    <div class="block-card">
                        <div class="block-card-header">
                            <div class="block-icon-container generic-shadow">
                                <img class="block-icon" alt="Block icon" src={blockIcon}/>
                            </div>
                            <div style="width: 100px;">
                                <a class="accessible" href={`/blockexplorer/blocks/${block.number}`}><p style="margin-top:0;margin-bottom:8px;">{block.number}</p></a>
                                <p style="margin: 0; opacity:.5; font-size:.9rem;">{timeAgo.format(block.timestamp*1000)}</p>
                            </div>
                        </div>
                        <div>
                            <p style="margin-top:0;margin-bottom:8px;">Proposer <span class="fake-link">{block.proposer}</span></p>
                            <p style="margin: 0;font-size:.9rem;opacity:.5;"><span>{block.content.ordered_transactions.length} transactions</span></p>
                        </div>
                        <div class="reward-container generic-shadow">
                            <p class="reward" style="font-size:.8rem">{block.reward} DEM</p>
                        </div>
                    </div>
                {/each}
            </div>
            <a href="/blockexplorer/blocks">
                <div class="card-footer color-transition">
                    View all blocks<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
                </div>
            </a>
        </div>
        <div>
            <h3 class="card-header">Latest transactions</h3>
            <div class="card">
                {#each data.block.content.ordered_transactions as transaction}
                <div class="block-card">
                    <div class="block-card-header">
                        <div class="block-icon-container generic-shadow">
                            <img class="block-icon" alt="Block icon" src={transIcon}/>
                        </div>
                        <div style="width: 200px;">
                            <a href={`/blockexplorer/transactions/${transaction.hash}`} class="accessible"><p class="block-cell" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p></a>
                            <p style="margin: 0; opacity:.5; font-size:.9rem;">{timeAgo.format(transaction.content.timestamp*1000)}</p>
                        </div>
                    </div>
                    <div>
                        <p style="margin-top:0;margin-bottom:8px;">From <span class="fake-link">{transaction.content.from}</span></p>
                        <p style="margin: 0;">To <span class="fake-link">{transaction.content.to}</span></p>
                    </div>
                    <div class="reward-container generic-shadow">
                        <p class="reward" style="font-size:.8rem">{transaction.content.amount} DEM</p>
                    </div>
                </div>
                {/each}
            </div>
            <a href="/blockexplorer/transactions">
                <div class="card-footer color-transition">
                    View all transactions<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
                </div>
            </a>
        </div>
    </div>
</div>