<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa'
    import { faArrowLeftLong, faArrowRightLong, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
    import Footer from '$lib/components/Footer.svelte';
    const links = [
        {
            label: "DOCS",
            url: "https://uploads-ssl.webflow.com/637666f7c0a45f6ef07fab12/64b5bebfccca8da619a1ea72_DEMOS%20Yellow%20Paper.pdf"
        },
        {
            label:"TWITTER",
            url:"https://twitter.com/KynesysLabs"
        }
    ]
    console.log(data.block);
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

    .card-body{
        padding: 16px;
    }
</style>

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

<main>
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
    <div class="card-body">
        <p class="info">Status: {data.block.status}</p>
        <p class="info">Timestamp: {data.block.timestamp}</p>
        <p class="info">Proposer: {data.block.proposer}</p>
        <p class="info">Transactions: <span class="fake-link">{data.block.content.transactions.length} transactions</span> in this block</p>
    </div>
</div>
</main>

<Footer/>