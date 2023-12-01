<script>
    import {chains} from "$lib/chainscript";
    import {trim_address} from "$lib/env";
    /** @type {{id: string, wallet: any}} */
    export let chain;
    /** @type {(chain: string, prvkey: string)=>Promise<boolean>} */
    export let connectWallet;
    export let error;
    let editing = false;
</script>

<div class="wallet-connection card">
    <!-- CHAIN NAME AND ICON-->
    <div class="wallet-info">
        {#if chains.find(ch=>ch.id==chain.id).icon}
        <img style="margin-bottom: 20px;" alt="chain icon" src={chains.find(ch=>ch.id==chain.id).icon} width="24" height="24"/>
        {/if}
        <h4 class="network-name">{chains.find(ch=>ch.id==chain.id).label}</h4>
    </div>
    <!-- CONNECTED? WALLET INFO : INPUT -->
    {#if chain.wallet}
        <div class="wallet-info">
            <p class="wallet-address">{trim_address(chain.wallet.getAddress(), 20)}</p>
            <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
        </div>
    {:else}
        {#if !editing}
        <button on:click={()=>{editing=chain.id}} class="secondary" style="width: 100%; justify-content:center;">Connect Wallet</button>
        {:else if editing == chain.id}
            <label for="prv_input" class="operationcard-label label">Private key</label>
            <input id="prv_input" class="prv-input" on:input={async (ev)=>{
                if(ev.target.value=="")
                return
                const connectionResult = await connectWallet(chain, ev.target.value)
                console.log("result", connectionResult);
                if(connectionResult)
                {
                    editing = false;
                }
            }} placeholder="Paste here"/>
        {/if}
    {/if}
    <!-- ERROR -->
    {#if error}
    <div class="alert-error">{error}</div>
    {/if}
</div>

<style>
    .wallet-connection{
        width: 100%;
        padding: 24px;
        margin-bottom: 16px;
    }
    .network-name{
        font-weight: bold;
        margin: 0 0 16px;
    }
    .wallet-info{
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .wallet-address{
        margin: 2px 0 0;
    }
    .wallet-status{
        margin: 0;
    }
    .operationcard-label{
        margin-top: 0;
        margin-bottom: 8px;
    }
    .prv-input{
        width: 100%;
    }
</style>