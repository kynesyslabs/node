<script>
	import CodePreview from "$lib/components/CodePreview.svelte";
	import Combobox from "$lib/components/Combobox.svelte";
	import { faCode, faEllipsisVertical, faTrash } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { cubicInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers/clickOutside.js'

    export let onBlockchainSelect;
    export let onOperationSelect;
    export let onRemove;
    export let txblock;
    export let index;
    
    let codemode = false;
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
    }
    .txblock-header-header{
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        gap: 16px;
    }
    .card-ellipsis-container{
        margin-left: auto;
        margin-right: 0;
        position: relative;
        display: flex;
        gap: 8px;
    }
    .card-ellipsis
    {
        padding: 8px;
        border-radius: 10px;
        background-color: #404040;
        color: white;
        font-size: 1rem;
        min-width: 40px;

    }
    .card-ellipsis:hover, .selected
    {
        background-color: var(--accent);
        color: black;
    }
    .txblock-header-label{
        margin:0;
        align-self: center;
    }

    .txblock-header-blockchain{
        display: flex;
        gap: 16px;
        align-items: center;
        max-width: 100%;
        width: 100%;
        padding-bottom: 28px;
        margin-bottom: 14px;
        border-bottom: var(--border);
        flex-wrap: wrap-reverse;
    }

    .txblock-body{
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
    }

    .txblock-input{
        max-width: 100%;
    }

    .options{
        position: absolute;
        top: 100%;
        right: 0;
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
        color: black;
    }

    .txblock{
        margin: 16px auto 32px;
    }
</style>

<div class="card txblock">
    <div class="txblock-header">
        <div class="txblock-header-header">
            <div class="txblock-header-blockchain">
                <p class="txblock-header-label">Blockchain:</p>
                <Combobox onChange={onBlockchainSelect} options={blockchainOptions} value={txblock.blockchain}/>
                <div class="card-ellipsis-container">
                    <button on:click={()=>{codemode=!codemode}} class={`card-ellipsis color-transition ${codemode?"selected":""}`}>
                        <Fa icon={faCode}></Fa>
                    </button>
                    <button on:click={()=>{if(!options)options=true}} class="card-ellipsis color-transition">
                        <Fa icon={faEllipsisVertical}></Fa>
                    </button>
                    {#if options}
                        <div use:clickOutside on:click_outside={()=>{options=false}} transition:customAnimation={{duration:100, easing:cubicInOut}} class="options generic-shadow">
                            <div role={`remove operation`} on:click={()=>{options=false;onRemove();}} class="option">
                                <Fa icon={faTrash}></Fa>
                                Remove
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>
    <div class="txblock-body generic-shadow">
        {#if !codemode}
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
        {:else}
            <CodePreview text={txblock.code} id={`code-editor${index}`}></CodePreview>
        {/if}
    </div>
    
</div>