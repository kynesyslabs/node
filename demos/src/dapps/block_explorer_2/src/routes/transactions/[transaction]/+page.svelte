<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa'
    import { faCopy } from '@fortawesome/free-solid-svg-icons';
    let selectedTab = 0;
    let copied = false;
    import transIcon from '$lib/assets/icons/agreement-icon.png';
    import { fade } from 'svelte/transition';

    console.log(data.transaction);
    function copy(value)
    {
        var aux = document.createElement("input");
        aux.setAttribute("value", value);
        document.body.appendChild(aux);
        aux.select();
        document.execCommand("copy");
        document.body.removeChild(aux);
        copied = true;
    }
</script>

<style>
    main{
        padding: 16px;
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
        width: 100%;
    }

    .info-grid{
        display: grid;
        grid-template-columns: 100px 1fr;
        width: 100%;
        gap: 16px;
        padding: 16px;
    }


    .page-controller-button{
        background-color: #404040;
        color: white;
        padding: 4px 8px;
        border-radius: var(--border-radius);
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
        cursor: pointer;
    }

</style>

<main>
<div class="card generic-shadow">
    <div class="card-header">
        <!--<div class="adjacent-button">
            <Fa style="position:relative;top:2px;" icon={faArrowLeftLong}></Fa>
        </div>-->
        <div class="block-header">
            <div class="block-icon-container generic-shadow">
                <img class="block-icon" alt="Block icon" src={transIcon}/>
            </div>
            <h4 class="ellipsis" style="margin: 0;">Transaction details</h4>
        </div>
        <!--<div class="adjacent-button">
            <Fa style="position:relative;top:2px;" icon={faArrowRightLong}></Fa>
        </div>-->        
    </div>
    <!--<div class="tab-container">
        <div role={`Block info tab ${selectedTab==0?"(selected)":""}`} on:click={()=>{changeTab(0)}} class={`tab ${selectedTab==0?"tab-selected":""}`}>
            <p class="tab-label">BLOCK INFO</p>
        </div>
        <div role={`Transaction tab ${selectedTab==1?"(selected)":""}`} on:click={()=>{changeTab(1)}} class={`tab ${selectedTab==1?"tab-selected":""}`}>
            <p class="tab-label">TRANSACTIONS</p>
        </div>
    </div>-->
    <div class="info-grid">
        <p class="info-title">Hash:</p>
        <div class="info"><p class="info-text">{data.transaction.hash}</p><button on:click={()=>{copy(data.transaction.hash)}} on:mouseleave={()=>{copied=false;}} class="page-controller-button tooltip"><span class="tooltiptext">{copied?"Copied!":"Copy"}</span><Fa icon={faCopy}></Fa></button></div>
        <p class="info-title">Type:</p>
        <div class="info"><p class="info-text">{data.transaction.content.content.type}</p></div>
        <p class="info-title">Currency:</p>
        <div class="info"><p class="info-text">{data.transaction.content.content.data.properties.name} ({data.transaction.content.content.data.properties.currency})</p></div>
        <p class="info-title">From:</p>
        <div class="info"><p class="info-text">{data.transaction.content.content.from}</p> <button on:click={()=>{copy(data.transaction.content.content.from)}} on:mouseleave={()=>{copied=false;}} class="page-controller-button tooltip"><span class="tooltiptext">{copied?"Copied!":"Copy"}</span><Fa class="tooltip" icon={faCopy}></Fa></button></div>
        <p class="info-title">To:</p>
        <div class="info"><p class="info-text">{data.transaction.content.content.to}</p> <button on:click={()=>{copy(data.transaction.content.content.to)}} on:mouseleave={()=>{copied=false;}} class="page-controller-button tooltip"><span class="tooltiptext">{copied?"Copied!":"Copy"}</span><Fa icon={faCopy}></Fa></button></div>
        <p class="info-title">Amount:</p>
        <div class="info"><p class="info-text">{data.transaction.content.content.amount}</p></div>
    </div>
</div>
</main>