<script>
    import demos from '$lib/demos.js';
    import Card from '$lib/components/surfaces/Card.svelte';
    let logged;
    async function createWallet()
    {
        let creation = await demos.DemosWebAuth.getInstance().create();
        console.log(creation);
        //console.log(demos.DemosWebAuth.getInstance().keypair);
        let loggation = await demos.DemosWebAuth.getInstance().login(demos.DemosWebAuth.getInstance().keypair.privateKey)
        console.log(loggation);
        //console.log(demos.DemosWebAuth.getInstance().loggedIn);
    }
    $: logged = demos.DemosWebAuth.getInstance().loggedIn;
</script>

<Card>
    <p>Authentication</p>
    {#if demos.DemosWebAuth.getInstance().loggedIn}
        <p>Logged in</p>
    {:else}
        <p>Not logged in</p>
        <button on:click={createWallet} class="primary">Create wallet</button>
    {/if}
</Card>