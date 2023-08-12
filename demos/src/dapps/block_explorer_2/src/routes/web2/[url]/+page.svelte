<script>
    import '$lib/global.css';
    import demos from '$lib/demos';
    export let data;
    import Fa from 'svelte-fa'
    import { faArrowLeftLong, faArrowRightLong, faChevronLeft, faChevronRight, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
    import Footer from '$lib/components/Footer.svelte';
	import Header from '$lib/components/Header.svelte';
    let selectedTab = 0;
    function changeTab(index){
        selectedTab = index;
    }
    const rpc = "http://85.208.48.187:53550";

    demos.connect(rpc);

    demos.getWeb2Data().then((result) => {
        console.log(result);
    });
</script>

<style>
    main{
        padding: 16px;
    }

    .logo{
        border-radius: 50%;
        width: 100px;
        margin: 16px;
    }

    .subtitle{
        text-align: center;
        margin-top: 0;
        font-family: 'Neue Machina', sans-serif;
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

    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        background-color: #252525;
    }

    .block-header{
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .adjacent-button{
        background-color: #404040;
        border-radius: 50%;
        padding: 8px;
        border: none;
        color: white;
        cursor: pointer;
        width: 37px;
        height: 37px;
        display: flex;
        justify-content: center;
    }

    .tab-container{
        display: flex;
        justify-content: center;
        margin: 16px 0;
        gap: 16px;
    }

    .tab{
        width: 120px;
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        text-align: center;
        cursor: pointer;
        background-color: #404040;
        font-size: .8rem;
    }

    .tab-selected{
        background-color: var(--accent);
        color: white;
        font-weight: bold;
    }

    .tab-label{
        margin: 0;
        padding: 16px 0;
    }

    .card-body{
        padding: 16px;
    }

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: #252525;
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
    }

    .transaction-number-label{
        margin: 0;
        position: relative;
        top: 4px;
    }

    .grid-header-row{
        background-color: #252525;
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
</style>

<Header></Header>

<!--<main>
<div class="card generic-shadow">
    <div class="card-header">
        <div class="adjacent-button">
            <Fa style="position:relative;top:2px;" icon={faArrowLeftLong}></Fa>
        </div>
        <div class="block-header">
            <div class="block-icon-container generic-shadow">
                <img class="block-icon" alt="Block icon" src="/icons/cube-icon.png"/>
            </div>
            <h4 style="margin: 0;">Block #{data.block.number}</h4>
        </div>
        <div class="adjacent-button">
            <Fa style="position:relative;top:2px;" icon={faArrowRightLong}></Fa>
        </div>        
    </div>
    <div class="tab-container">
        <div role={`Block info tab ${selectedTab==0?"(selected)":""}`} on:click={()=>{changeTab(0)}} class={`tab ${selectedTab==0?"tab-selected":""}`}>
            <p class="tab-label">BLOCK INFO</p>
        </div>
        <div role={`Transaction tab ${selectedTab==1?"(selected)":""}`} on:click={()=>{changeTab(1)}} class={`tab ${selectedTab==1?"tab-selected":""}`}>
            <p class="tab-label">TRANSACTIONS</p>
        </div>
    </div>
    {#if selectedTab==0}
        <div class="card-body">
            <p class="info">Status: {data.block.status}</p>
            <p class="info">Timestamp: {data.block.timestamp}</p>
            <p class="info">Proposer: {data.block.proposer}</p>
            <p class="info">Transactions: <span class="fake-link">{data.block.content.transactions.length} transactions</span> in this block</p>
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
                <p class="grid-cell fake-link">{transaction.hash}</p>
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
</main>-->

<Footer/>