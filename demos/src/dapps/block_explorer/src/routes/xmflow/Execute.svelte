<script>
    export let required_connections
</script>

<div style="margin-bottom: 32px;">
    <h4>Available blocks</h4>
    <div class="label">You can drag these nodes to the editor pane.</div>
    {#each required_connections as required_wallet}
        <div class="wallet-connection card">
            <div class="wallet-info">
                {#if chains.find(ch=>ch.id==required_wallet.id).icon}
                <img style="margin-bottom: 20px;" alt="chain icon" src={chains.find(ch=>ch.id==required_wallet.id).icon} width="24" height="24"/>
                {/if}
                <h4 class="network-name">{chains.find(ch=>ch.id==required_wallet.id).label}</h4>
            </div>
            {#if required_wallet.wallet}
                <div class="wallet-info">
                    <p class="wallet-address">{trim_address(required_wallet.wallet.getAddress())}</p>
                    <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
                </div>
            {:else}
                <button on:click={()=>{editwallet=required_wallet}} class="secondary" style="width: 100%;">Connect wallet</button>
            {/if}
        </div>
    {/each}
</div>

<style>
    .label {
		margin: 1rem 0;
		font-size: 0.9rem;
        opacity: .6;
	}
</style>