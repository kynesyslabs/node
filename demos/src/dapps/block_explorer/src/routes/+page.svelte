<script>
    import Fa from 'svelte-fa'
    import { faArrowRightLong } from '@fortawesome/free-solid-svg-icons'
    import '$lib/global.css'
    export let data;
    const latestBlocks = [data.block];
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import transIcon from '$lib/assets/icons/agreement-icon.png';
</script>

<style>
    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        background-color: #252525;
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

<div class="main-grid">

    <div class="card generic-shadow">
        <h4 class="card-header">Latest blocks</h4>
        {#each latestBlocks as block}
            <div class="block-card">
                <div class="block-card-header">
                    <div class="block-icon-container generic-shadow">
                        <img class="block-icon" alt="Block icon" src={blockIcon}/>
                    </div>
                    <div style="width: 100px;">
                        <a class="accessible" href={`/blocks/${block.number}`}><p style="margin-top:0;margin-bottom:8px;">{block.number}</p></a>
                        <p style="margin: 0; opacity:.5; font-size:.9rem;">{block.timestamp}</p>
                    </div>
                </div>
                <div>
                    <p style="margin-top:0;margin-bottom:8px;">Proposer <span class="fake-link">{block.proposer}</span></p>
                    <p style="margin: 0;font-size:.9rem;opacity:.5;"><span>{block.content.transactions.length} transactions</span><!--<span style="opacity:.5"> {block.time/100} secs</span>--></p>
                </div>
                <div class="reward-container generic-shadow">
                    <p class="reward" style="font-size:.8rem">{block.reward} DEM</p>
                </div>
            </div>
        {/each}
        <a href="/blocks">
            <div class="card-footer color-transition">
                View all blocks<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
            </div>
        </a>
    </div>
    <div class="card">
        <h4 class="card-header">Latest transactions</h4>
        {#each data.block.content.transactions as transaction}
        <div class="block-card">
            <div class="block-card-header">
                <div class="block-icon-container generic-shadow">
                    <img class="block-icon" alt="Block icon" src={transIcon}/>
                </div>
                <div style="width: 200px;">
                    <a href={`/transactions/${transaction.hash}`} class="accessible"><p class="block-cell" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p></a>
                    <p style="margin: 0; opacity:.5; font-size:.9rem;">{transaction.age}</p>
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
        <a href="/transactions">
            <div class="card-footer color-transition">
                View all transactions<Fa style="position:relative;top:2px;margin-left:8px" icon={faArrowRightLong}></Fa>
            </div>
        </a>
    </div>
</div>

</div>