<script>
    import {rpcaddress, updateRpcAddress} from "$lib/env.js";
    import {budinofade, budinotraslato} from '$lib/transitions.js';
    import "$lib/styles/crosschain/operationeditor.css";
    export let close;
    let initial = $rpcaddress;
    const savedAddresses = JSON.parse(localStorage.getItem("addresses"));
    let addresses = savedAddresses?savedAddresses:initial=="https://rpc.demoscan.live"?[initial]:["https://rpc.demoscan.live", initial];
    $: localStorage.setItem("addresses", JSON.stringify(addresses));
    $:localStorage.setItem("selectedrpc", $rpcaddress);
    let adding = false;
    function deleteAddress(address)
    {
        addresses = addresses.filter((addr)=>addr!=address);
    }
</script>


<style>
    .chain-label{
        margin: 0;
        font-size: 1rem;
    }
    .chain-options{
        margin-top: 16px;
    }
    .node-option{
        gap: 8px;
        cursor: pointer;
        padding: var(--input-padding) 0;
        width: 100%;
        transition: padding .2s ease-in-out, background-color .2s ease-in-out, color .2s ease-in-out;
        margin: 4px 0;
    }
    .node-option-selected{
        text-decoration: underline;
    }
    .node-container{
        display: grid;
        align-items: center;
        grid-template-columns: 24px 1fr 24px;
        gap: 16px;
    }
    .input-group{
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 16px 0;
        border: 1px solid var(--background3);
    }
</style>

<div class="modal-background" transition:budinofade>
    <div transition:budinotraslato class="modal-txblock" style="width: 500px; max-width:calc(100% - 48px);">
        <h3 class="operationcard-label">Node Address</h3>
        <div class="chain-options">
            {#each addresses as address, i}
                <div class="node-container">
                    {#if address == $rpcaddress}
                        <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g id="check--check-form-validation-checkmark-success-add-addition-tick"><path id="Vector 2356 (Stroke)" fill="var(--color)" fill-rule="evenodd" d="M23.914 6.914 8.5 22.33.086 13.914l2.828-2.828L8.5 16.672 21.086 4.086l2.828 2.828Z" clip-rule="evenodd"></path></g></svg>
                    {:else}
                        <div></div>
                    {/if}
                    <button on:click={()=>{updateRpcAddress(address); close();}} class={`node-option ${$rpcaddress==address?"node-option-selected":""}`}>
                        <p class="chain-label">{address}</p>
                    </button>
                    {#if i !== 0}
                        <button on:click={()=>{deleteAddress(address)}}>
                            <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g id="recycle-bin-2--remove-delete-empty-bin-trash-garbage"><path id="Subtract" fill="var(--color)" fill-rule="evenodd" d="M9.17 5a3.001 3.001 0 0 1 5.66 0H9.17ZM7.1 5a5.002 5.002 0 0 1 9.8 0H23v2h-2v16H3V7H1V5h6.1Zm.4 13.5v-8h2v8h-2Zm7-8v8h2v-8h-2Z" clip-rule="evenodd"></path></g></svg>
                        </button>
                    {:else}
                        <div></div>
                    {/if}
                </div>
            {/each}
        </div>
        {#if !adding}
            <div style="display: flex; gap:8px">
                <button class="secondary input-group" on:click={()=>{close();}}>Cancel</button>
                <button class="secondary input-group" on:click={()=>{adding = true;}}>Add address</button>
            </div>
        {:else}
            <form on:submit={(ev)=>{
                ev.preventDefault();
                addresses = [...addresses, ev.target[0].value];
                adding = false;
            }} class="input-group">
                <input type="text" placeholder="Node address" class="smallinput" style="border:none;"/>
                <button class="secondary" type="submit" style="border:none; border-left:1px solid var(--background3);">Add</button>
            </form>
            <button class="futuristic" on:click={()=>{adding= false;}}>[cancel]</button>
        {/if}
    </div>
</div>