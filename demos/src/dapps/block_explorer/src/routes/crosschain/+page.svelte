<script>
	import { faCode, faLongArrowRight, faPlus } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
	import Combobox from "../../lib/components/Combobox.svelte";
	import CodePreview from "$lib/components/CodePreview.svelte";

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

    let txblocks = [
        {
            blockchain:"ETH",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001",
            mode:"nocode",
            code:`import demos from "demos";

export default function main(){
    
}`
        },
        {
            blockchain:"SOL",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001",
            mode:"nocode",
            code:`import demos from "demos";

export default function main(){
    
}`
        }
    ]


    function addOperation(){
        txblocks.push({
            blockchain:undefined,
            operation:undefined,
            receivingAddress:"",
            amount:"",
            mode:"nocode",
            code:`import demos from "demos";

export default function main(){
    
}`
        })
        txblocks = txblocks;
    }
</script>

<style>
    .txblock-header{
        border-radius: var(--border-radius) var(--border-radius) 0 0;
        border-bottom: 1px solid var(--border-color);
        background-color: var(--header-color);
    }
    .txblock-header-header{
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        width: 100%;
        padding: 8px 16px;
    }
    .txblock-header-label{
        margin:0;
        align-self: center;
    }

    .txblock-header-blockchain{
        display: flex;
        gap: 16px;
        padding: 4px 0 8px;
        align-items: center;
        max-width: 100%;
    }

    .tab-container{
        display: flex;
        align-items: end;
        margin: 0 4px;
        gap: -8px;
    }
    .tab{
        background-color: #202020;
        border-radius: var(--border-radius) var(--border-radius) 0 0;
        color: white;
        font-weight: bold;
        display: flex;
        align-items: center;
        width: 150px;
        justify-content: center;
        padding: 8px 0;
        border-bottom: none;
        border: 1px solid var(--border-color);
        border-bottom: none;
        position: relative;
    }
    .tab-secondary{
        background-color: var(--header-color);
        border: none;
    }
    .tab-secondary:hover{
        background-color: #252525;
        cursor: pointer;
    }
    .selected::after{
        content: "";
        display: block;
        width: 100%;
        height: 1px;
        background-color: #202020;
        position: absolute;
        bottom: -1px;
    }
    .tab-label{
        margin: 0;
    }
    .txblock-body{
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
        padding: 16px;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
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
    .remove-button{
        display: block;
        background-color: transparent;
        border:none;
        color: var(--accent-accessible);
        font-size: 1rem;
        text-decoration: underline;
        cursor: pointer;
    }
    .action-buttons{
        display: flex;
        justify-content: right;
        text-align: center;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
        gap: 16px;
        flex-wrap: wrap;
    }
    .card-footer-button{
        text-align: center;
        padding: 12px 16px;
        border-radius: var(--border-radius);
        width: 200px;
        cursor: pointer;
    }
    .buttons-container{
        display:flex;
        justify-content:right;
        gap: 16px;
        margin-right: 16px;
    }
</style>

<main>
        <h4 style="margin-bottom:16px;">Crosschain transaction</h4>
        {#each txblocks as txblock, i}
            <div class="card">
                <div class="txblock-header">
                    <div class="txblock-header-header">
                        <div class="txblock-header-blockchain">
                            <p class="txblock-header-label">Blockchain:</p>
                            <Combobox style="padding:8px; width:250px; margin:0;" onChange={(v)=>{txblocks[i].blockchain = v}} options={blockchainOptions} value={txblock.blockchain}/>
                        </div>
                        {#if txblocks.length > 2}
                            <button on:click={()=>{txblocks.splice(i, 1); txblocks=txblocks}} class="remove-button">Remove operation</button>
                        {/if}
                    </div>

                    <div class="tab-container">
                        <div role={`Nocode tab`} on:click={()=>{txblock.mode = "nocode"}} class={`tab color-transition ${txblock.mode=="nocode"?"selected":"tab-secondary"}`}>
                            <p class="tab-label">No code</p>
                        </div>
                        <div role={`Code tab`} on:click={()=>{txblock.mode = "code"}} class={`tab color-transition ${txblock.mode=="code"?"selected":"tab-secondary"}`}>
                            <p class="tab-label">Code</p>
                        </div>
                    </div>
                </div>
                <div class="txblock-body generic-shadow">
                    {#if txblock.mode == "nocode"}
                        <div class="txblock-input">
                            <p class="label">Select operation</p>
                            <Combobox onChange={(v)=>{txblocks[i].operation = v}} options={operationOptions} value={txblock.operation}/>
                        </div>
                        <div class="txblock-input">
                            <p class="label">Receiving address</p>
                            <input value={txblock.receivingAddress}/>
                        </div>
                        <div class="txblock-input">
                            <p class="label">Amount</p>
                            <input value={txblock.amount} style="width: 150px;"/>
                        </div>
                    {:else}
                        <div class="txblock-input" style="width: 100%;">
                            <div>
                                <CodePreview text={txblock.code} id={`code-editor${i}`}></CodePreview>
                            </div>
                        </div>
                    {/if}
                </div>
                
            </div>
        {/each}
        <div class="action-buttons">
            <div role={`Add operation`} on:click={()=>{addOperation()}} style="border:1px solid var(--border-color); background-color:var(--header-color);" class="card-footer-button color-transition generic-shadow"><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</div>
            <div class="card-footer-button color-transition generic-shadow" style="background-color: var(--accent);">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></div>
        </div>
</main>