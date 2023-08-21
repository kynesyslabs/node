<script>
	import CodePreview from "$lib/components/CodePreview.svelte";
	import Combobox from "$lib/components/Combobox.svelte";
	import { faEllipsisVertical, faTrash } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { cubicInOut } from 'svelte/easing';
    export let onBlockchainSelect;
    export let onOperationSelect;
    export let onRemove;
    export let txblock;
    export let index;

    let mode = "nocode";
    let options = false;

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


    function customAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scale(${0.9 + eased/10});
                    opacity: ${eased};
                    transform-origin:top right;
                );`;
            }
        };
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
        width: 100%;
        padding: 8px 16px;
        gap: 16px;
    }
    .card-ellipsis-container{
        margin-left: auto;
        margin-right: 0;
        position: relative;
    }
    .card-ellipsis
    {
        padding: 8px;
        border-radius: var(--border-radius);
        background-color: #404040;
        color: white;
        font-size: 1rem;
        min-width: 40px;

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
        width: 100%;
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
    .remove-button{
        display: block;
        background-color: transparent;
        border:none;
        color: var(--accent-accessible);
        font-size: 1rem;
        text-decoration: underline;
        cursor: pointer;
    }
    .buttons-container{
        display:flex;
        justify-content:right;
        gap: 16px;
        margin-right: 16px;
    }

    .options{
        position: absolute;
        top: 100%;
        right: calc(-100% + 40px);
        width: 200px;
        border-radius: var(--border-radius);
        box-shadow: var(--box-shadow);
        z-index: 100;
        background-color: #505050;
        max-width: 100dvw;
    }

    .option{
        padding: 0.7rem;
        cursor: pointer;
        background-color: #505050;
        display: grid;
        grid-template-columns: 25px 1fr;
        margin: 0;
        border-radius: var(--border-radius);
    }

    .option:hover{
        background-color: var(--accent);
    }
</style>

<div class="card">
    <div class="txblock-header">
        <div class="txblock-header-header">
            <div class="txblock-header-blockchain">
                <p class="txblock-header-label">Blockchain:</p>
                <Combobox style="padding:8px; width:250px; margin:0;" onChange={onBlockchainSelect} options={blockchainOptions} value={txblock.blockchain}/>
                <div class="card-ellipsis-container">
                    <button on:click={()=>{options=!options}} class="card-ellipsis generic-shadow">
                        <Fa icon={faEllipsisVertical}></Fa>
                    </button>
                    {#if options}
                        <div transition:customAnimation={{duration:100, easing:cubicInOut}} class="options generic-shadow">
                            <div role={`remove operation`} on:click={()=>{options=false;onRemove();}} class="option">
                                <Fa icon={faTrash}></Fa>
                                Remove
                            </div>
                        </div>
                    {/if}
                </div>
            </div>

            <!--{#if txblocks.length > 2}
                <button on:click={()=>{txblocks.splice(i, 1); txblocks=txblocks}} class="remove-button">Remove operation</button>
            {/if}-->
        </div>

        <div class="tab-container">
            <div role={`Nocode tab`} on:click={()=>{mode = "nocode"}} class={`tab color-transition ${mode=="nocode"?"selected":"tab-secondary"}`}>
                <p class="tab-label">No code</p>
            </div>
            <div role={`Code tab`} on:click={()=>{mode = "code"}} class={`tab color-transition ${mode=="code"?"selected":"tab-secondary"}`}>
                <p class="tab-label">Code</p>
            </div>
        </div>
    </div>
    <div class="txblock-body generic-shadow">
        {#if mode == "nocode"}
            <div class="txblock-input">
                <p class="label">Select operation</p>
                <Combobox onChange={onOperationSelect} options={operationOptions} value={txblock.operation}/>
            </div>
            <div class="txblock-input">
                <p class="label">Receiving address</p>
                <input value={txblock.receivingAddress}/>
            </div>
            <div class="txblock-input">
                <p class="label">Amount</p>
                <input value={txblock.amount} style="width: 150px;"/>
            </div>
        {/if}
        {#if mode == "code"}
            <CodePreview text={txblock.code} id={`code-editor${index}`}></CodePreview>
        {/if}
    </div>
    
</div>