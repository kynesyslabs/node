<script>
	import { faCircleNotch, faSearch, faTimesCircle } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { budinofade } from "$lib/transitions";
    import debounce from "debounce";
    export let onChange;
    export let setSearchMode;
    let value = "";
    let loading = false;
    const debounced = debounce(()=>{loading = false; onChange(value)}, 1000);
    $: if(value!=="")
    {
        loading = true;
        debounced();
    }
    else
    {
        setSearchMode(false);
    }
</script>
<style>
    .searchbar-button{
        font-size: inherit;
        padding: 0;
        background: none;
        color: white;
        color:#A8ACAF;
    }
</style>
<div class="input-container">
    <Fa style="color:#A8ACAF;" icon={faSearch}></Fa>
    <input bind:value={value} class="embedded-input" type="text" placeholder="Search" />
    {#if loading}
    <Fa icon={faCircleNotch} color="#A8ACAF" spin></Fa>
    {/if}
    {#if value.length > 0 && !loading}
    <button transition:budinofade class="searchbar-button" on:click={()=>{value = "";}}><Fa icon={faTimesCircle}></Fa></button>
    {/if}
</div>