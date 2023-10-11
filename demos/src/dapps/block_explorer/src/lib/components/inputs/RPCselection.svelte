<script>
    import {rpcaddress, updateRpcAddress} from "$lib/env.js";
    import {budinofade, budinotraslato} from '$lib/transitions.js';
    import "$lib/styles/crosschain/operationeditor.css";
    export let close;
    let initial = $rpcaddress;
    let addresses = initial=="https://rpc.demoscan.live"?[initial]:["https://rpc.demoscan.live", initial];
    let adding = false;
</script>


<style>
    .chain-label{
        margin: 0 0 4px;
        font-size: 1rem;
    }
    .chain-options{
        margin-top: 16px;
    }
    .chain-option{
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: var(--input-padding) 0;
        width: 100%;
        transition: padding .2s ease-in-out, background-color .2s ease-in-out, color .2s ease-in-out;
        margin-bottom: 8px;
    }
    .chain-option-selected{
        background-color: var(--accent);
        padding: var(--input-padding);
        color: black;
        margin-bottom: 8px;
    }
</style>

<div class="modal-background" transition:budinofade>
    <div transition:budinotraslato class="modal-txblock">
        <h3 class="operationcard-label">Select node addrress</h3>
        <div class="chain-options">
            {#each addresses as address}
                <button on:click={()=>{updateRpcAddress(address); close();}} class={$rpcaddress==address?"chain-option-selected":"chain-option"}>
                    <p class="chain-label">{address}</p>
                </button>
            {/each}
        </div>
        {#if !adding}
            <button class="secondary" on:click={()=>{adding = true;}}>Add address</button>
        {:else}
            <form on:submit={(ev)=>{
                ev.preventDefault();
                addresses = [...addresses, ev.target[0].value];
                adding = false;
            }} class="input-group">
                <input type="text" placeholder="Node address"/>
                <button class="secondary" type="submit">Add</button>
            </form>
        {/if}
    </div>
</div>