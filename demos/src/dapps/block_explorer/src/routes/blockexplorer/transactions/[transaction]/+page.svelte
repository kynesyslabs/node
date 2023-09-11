<script>
    import '$lib/global.css';
    export let data;
    import transIcon from '$lib/assets/icons/agreement-icon.png';
	import CopyButton from '$lib/components/CopyButton.svelte';
    console.log(data.transaction);
</script>

<style>
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
    .block-icon{
        filter: invert();
        width: 45px;
    }

    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .block-header{
        display: flex;
        align-items: center;
        width: 100%;
        margin-bottom: 64px;
        gap: 16px;
        justify-content: center;
    }

    .info-grid{
        display: grid;
        grid-template-columns: 100px 1fr;
        width: 100%;
        gap: 8px;
    }
    .info-grid:not(:last-child){
        margin-bottom: 32px;
    }
    .info-title{
        font-weight: bold;
    }
    .card{
        padding: 32px;
        width: fit-content;
        margin: 0 auto 64px;
    }
    @media (max-width: 650px){
        .info-grid{
            grid-template-columns: 1fr;
        }
        .card{
            padding: 24px;
        }
    }
</style>
<div class="card-header">
    <div class="block-header">
        <div class="block-icon-container generic-shadow">
            <img class="block-icon" alt="Block icon" src={transIcon}/>
        </div>
        <h3 class="ellipsis" style="margin: 0;">Transaction details</h3>
    </div>      
</div>
<div class="card">
    <div class="info-grid">
        <p class="info-title">Hash:</p>
        <div class="info"><p class="info-text">{data.transaction.hash}</p><CopyButton text={data.transaction.hash}/></div>
    </div>
    <div class="info-grid">
        <p class="info-title">Type:</p>
        <div class="info"><p class="info-text">{data.transaction.content.type}</p></div>
    </div>
    <div class="info-grid">
        <p class="info-title">Currency:</p>
        <div class="info"><p class="info-text">{data.transaction.content.data.properties.name} ({data.transaction.content.data.properties.currency})</p></div>
    </div>
    <div class="info-grid">
        <p class="info-title">From:</p>
        <div class="info"><p class="info-text">{data.transaction.content.from}</p><CopyButton text={data.transaction.content.from}></CopyButton></div>
    </div>
    <div class="info-grid">
        <p class="info-title">To:</p>
        <div class="info"><p class="info-text">{data.transaction.content.to}</p><CopyButton text={data.transaction.content.to}></CopyButton></div>
    </div>
    <div class="info-grid">
        <p class="info-title">Amount:</p>
        <div class="info"><p class="info-text">{data.transaction.content.amount}</p></div>
    </div>
</div>