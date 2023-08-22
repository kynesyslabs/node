<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa'
    import { faArrowLeftLong, faArrowRightLong, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import infoIcon from '$lib/assets/icons/Circle_Info.svg';
    import transIcon from '$lib/assets/icons/Arrow_Down_Up.svg';
    let selectedTab = 0;
    function changeTab(index){
        selectedTab = index;
    }

    //console.log(data.pblock);
</script>

<style>
    main{
        padding: 16px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
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
        width: 50px;
    }


    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        justify-content: center;
    }

    .block-header{
        display: flex;
        align-items: center;
    }

    .adjacent-button{
        border: var(--border);
        border-radius: 50%;
        padding: 8px;
        color: white;
        cursor: pointer;
        width: 37px;
        height: 37px;
        display: flex;
        justify-content: center;
        position: relative;
    }

    .tab-container{
        display: flex;
        align-items: end;
        margin: 0 0 16px;
        gap: -8px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(15px);
        padding: 6px;
        border: var(--border);
    }
    .tab{
        border-radius: 8px;
        color: white;
        display: flex;
        align-items: center;
        width: 250px;
        justify-content: center;
        padding: 12px 0;
        border-bottom: none;
        border: 1px solid var(--border-color);
        border-bottom: none;
        position: relative;
    }
    .tab-secondary{
        border: none;
    }
    .tab-secondary:hover{
        cursor: pointer;
    }
    .tab-selected{
        background-color: var(--accent);
        color: black;
    }
    .tab-label{
        margin: 0;
    }
    

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: var(--header-color);
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
    }

    .page-controller{
        display: flex;
        gap:4px;
        align-items: center;
        justify-content: right;
    }

    .page-controller-button{
        background-color: #404040;
        color: white;
        padding: 4px 8px;
        border-radius: var(--border-radius);
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
    }
    .page-controller-label{
        margin:0;
        font-size: .8rem;
        position: relative;
        margin-top: 4px;
    }
    .transactions-info{
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        border-bottom: 1px solid var(--border-color);
    }

    .transactions-grid{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 16px;
        border-bottom: 1px solid var(--border-color);
        padding: 16px;
        width: 100%;
    }

    .transaction-number-label{
        margin: 0;
        position: relative;
        top: 4px;
    }

    .grid-header-row{
        background-color: var(--header-color);
    }

    .grid-header-label{
        font-weight: bold;
        margin:0;
    }

    .grid-cell{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 0;
    }

    .info-grid{
        display: grid;
        grid-template-columns: 100px 1fr;
        width: 100%;
        gap: 16px;
        padding: 28px;
    }

    .info-title{
        font-weight: bold;
        margin: 0;
    }

    .info-text{
        margin: 0;
        opacity: .8;
    }

    .info{
        word-wrap: break-word;
        word-break: break-all;
        display: flex;
        align-items: center;
        gap: 8px;
    }
</style>

<main>
<div class="card" style="width: fit-content;">
    <div class="card-header">
        <div class="adjacent-button">
            <Fa style="position:relative;top:1px;" icon={faArrowLeftLong}></Fa>
        </div>
        <div class="block-header">
            <div class="block-icon-container generic-shadow">
                <img class="block-icon" alt="Block icon" src={blockIcon}/>
            </div>
            <h3 style="margin: 0; margin-right:8px;">Block #{data.block.number}</h3>
        </div>
        <div class="adjacent-button">
            <Fa style="position:relative;top:1px;" icon={faArrowRightLong}></Fa>
        </div>        
    </div>
</div>

<div class="tab-container">
    <div></div>
    <div role={`Block info tab ${selectedTab==0?"(selected)":""}`} on:click={()=>{changeTab(0)}} class={`color-transition tab ${selectedTab==0?"tab-selected":"tab-secondary"}`}>
        <img class={`${selectedTab==0?"invert":""}`} src={infoIcon} alt="Info icon" style="margin-right: 8px;"/><p class="tab-label">Block info</p>
    </div>
    <div role={`Transaction tab ${selectedTab==1?"(selected)":""}`} on:click={()=>{changeTab(1)}} class={`color-transition tab ${selectedTab==1?"tab-selected":"tab-secondary"}`}>
        <img class={`${selectedTab==1?"invert":""}`} src={transIcon} alt="Info icon" style="margin-right: 8px; height:24px;"/><p class="tab-label">Transactions</p>
    </div>
</div>

<div class="grid-card" style="max-width:1250px; margin:auto;">
    {#if selectedTab==0}
        <div class="info-grid">
            <p class="info-title">Status:</p>
            <p class="info-text">{data.block.status}</p>
            <p class="info-title">Timestamp:</p>
            <p class="info-text">{data.block.timestamp}</p>
            <p class="info-title">Proposer:</p>
            <p class="info-text">{data.block.proposer}</p>
            <p class="info-title">Transactions:</p>
            <p class="info-text">{data.block.content.transactions.length} transactions in this block</p>
        </div>
    {:else}
        <div class="transactions-info">
            <p class="transaction-number-label">A total of {data.block.content.transactions.length} transactions found</p>
        </div>
        <div class="transactions-grid grid-header-row">
            <p class="grid-header-label">Hash</p>
            <p class="grid-header-label">From</p>
            <p class="grid-header-label">To</p>
            <p class="grid-header-label">Amount</p>
        </div>
        <div class="transactions-grid">
            {#each data.block.content.transactions as transaction}
                <a class="accessible grid-cell" href={`/transactions/${transaction.hash}`}><p class="grid-cell">{transaction.hash}</p></a>
                <p class="grid-cell">{transaction.content.from}</p>
                <p class="grid-cell">{transaction.content.to}</p>
                <p class="grid-cell">{transaction.content.amount}</p>
            {/each}
        </div>
        <div class="card-footer">
            <div class="page-controller">
                <button class="page-controller-button">First</button>
                <button class="page-controller-button"><Fa icon={faChevronLeft}/></button>
                    <p class="page-controller-label">Page 1 of 1</p>
                <button class="page-controller-button"><Fa icon={faChevronRight}/></button>
                <button class="page-controller-button">Last</button>
            </div>
        </div>
    {/if}
</div>
</main>