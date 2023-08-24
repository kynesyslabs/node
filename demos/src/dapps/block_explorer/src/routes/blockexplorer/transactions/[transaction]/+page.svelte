<script>
    import '$lib/global.css';
    export let data;
    let copied = false;
    import transIcon from '$lib/assets/icons/agreement-icon.png';
	import CopyButton from '../../../../lib/components/CopyButton.svelte';

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

    function mouseenterHandler()
    {
        copied = false;
    }
    console.log(data);
</script>

<style>
    .main{
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
    }

    .block-header{
        display: flex;
        align-items: center;
        width: 100%;
        margin-bottom: 28px;
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
        border-radius: 8px;
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
        cursor: pointer;
    }

    .page-controller-button:hover{
        background-color: var(--accent);
        color: black;
    }

</style>

<div class="main">
    <div class="card" style="width: fit-content; margin:auto;">
        <div class="card-header">
            <div class="block-header">
                <div class="block-icon-container generic-shadow">
                    <img class="block-icon" alt="Block icon" src={transIcon}/>
                </div>
                <h3 class="ellipsis" style="margin: 0;">Transaction details</h3>
            </div>      
        </div>
        <div class="info-grid">
            <p class="info-title">Hash:</p>
            <div class="info"><p class="info-text">{data.transaction.hash}</p><CopyButton text={data.transaction.hash}/></div>
            <p class="info-title">Type:</p>
            <div class="info"><p class="info-text">{data.transaction.content.type}</p></div>
            <p class="info-title">Currency:</p>
            <div class="info"><p class="info-text">{data.transaction.content.data.properties.name} ({data.transaction.content.data.properties.currency})</p></div>
            <p class="info-title">From:</p>
            <div class="info"><p class="info-text">{data.transaction.content.from}</p><CopyButton text={data.transaction.content.from}></CopyButton></div>
            <p class="info-title">To:</p>
            <div class="info"><p class="info-text">{data.transaction.content.to}</p><CopyButton text={data.transaction.content.to}></CopyButton></div>
            <p class="info-title">Amount:</p>
            <div class="info"><p class="info-text">{data.transaction.content.amount}</p></div>
        </div>
    </div>
</div>