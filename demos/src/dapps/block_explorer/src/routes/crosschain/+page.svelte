<script>
	import { faCheck, faChevronDown, faCode, faCross, faLongArrowRight, faPlus, faTimes } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
	import Combobox from "../../lib/components/Combobox.svelte";

    const blockchainOptions = [
        {
            id:"ETH",
            label:"Ethereum"
        },
        {
            id:"SOL",
            label:"Solana"
        },
        {
            id:"DOT",
            label:"Polkadot"
        },
        {
            id:"ADA",
            label:"Cardano"
        }
    ]

    const operationOptions = [
        {
            id:"Transfer",
            label:"Transfer"
        },
        {
            id:"Swap",
            label:"Swap"
        },
        {
            id:"Deposit",
            label:"Deposit"
        },
        {
            id:"Withdraw",
            label:"Withdraw"
        }
    ]

    const txblocks = [
        {
            blockchain:"ETH",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001"
        },
        {
            blockchain:"SOL",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001"
        }
    ]
</script>

<style>
    .text-editor-container{
        width: 100%;
        height: 100dvh;
        position: absolute;
        top: 0;
        left: 0;
        background-color: #101010;
        z-index: 1;
    }
    .text-editor-header{
        padding: 16px;
        background-color: #252525;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .text-editor{
        width: 100%;
        height: 100%;
        background-color: transparent;
        color: white;
        border: none;
        outline: none;
        resize: none;
        padding: 16px;
        font-size: 1rem;
        font-family: monospace;
    }
    hr{
        height: 1px;
        border: none;
        background-color: var(--border-color);
        margin: 0;
    }
    .txblock{
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
    }
    .txblock{
        padding: 16px 16px 24px;
    }
    .txblock-input{
        max-width: 100%;
    }
    .txblock-button{
        padding: .7rem;
        border-radius: var(--border-radius);
        background-color: #404040;
        color: white;
        font-size: 1rem;
        min-width: 40px;
    }
    .txblock-button:hover{
        background-color: var(--accent);
        cursor: pointer;
    }
    main{
        padding: 16px;
    }
    .card-footer{
        display: flex;
        justify-content: space-between;
        text-align: center;
        background-color: #252525;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
    }
    .card-footer-button{
        width: 100%;
        text-align: center;
        padding: 16px;
    }
    .card-footer-button:hover{
        color: var(--accent);
        cursor: pointer;
    }
</style>

<!--<div class="text-editor-container">
    <div class="text-editor-header">
        <h4 style="margin:0;">Code editor for crosschain transaction</h4>
        <div>
            <button class="txblock-button" style="margin-right:8px;"><Fa icon={faCheck}></Fa></button>
            <button class="txblock-button"><Fa icon={faTimes}></Fa></button>
        </div>
    </div>
    <textarea class="text-editor"></textarea>
</div>-->

<main>
    <div class="card">
        <div class="card-header"><h4 style="margin: 0;">Crosschain transaction</h4></div>
        {#each txblocks as txblock, i}
            <div class="txblock">
                <div class="txblock-input">
                    <p class="label">Select blockchain</p>
                    <Combobox options={blockchainOptions} value={txblock.blockchain}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Select operation</p>
                    <Combobox options={operationOptions} value={txblock.operation}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Receiving address</p>
                    <input value={txblock.receivingAddress}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Amount</p>
                    <input value={txblock.amount} style="width: 150px;"/>
                </div>
                <div class="txblock-input">
                    <p class="label">Code</p>
                    <button class="txblock-button"><Fa icon={faCode}></Fa></button>
                </div>
            </div>
            <hr/>
        {/each}
        <div class="card-footer">
            <div class="card-footer-button" style="border-right:1px solid var(--border-color);"><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</div>
            <div class="card-footer-button">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></div>
        </div>
    </div>
</main>