<script>
	import AvailableBlocks from "./AvailableBlocks.svelte";
	import Execute from "./Execute.svelte";
	let tab = "blocks";
	export let required_connections;
</script>
<aside class="drawer open">
	<div class="tabs">
		<button class={`tab ${tab=="blocks"?"selected":""}`} on:click={()=>{tab="blocks"}}>Blocks</button>
		<button class={`tab ${tab=="execute"?"selected":""}`} on:click={()=>{tab="execute"}}>Execute</button>
	</div>
	{#if tab == "blocks"}
    <AvailableBlocks></AvailableBlocks>
	{:else if tab == "execute"}
	<Execute {required_connections}></Execute>
	{/if}
</aside>

<style>

	.drawer {
		max-width: 429px;
		height: 100dvh;
		position: fixed;
		left: 0;
		top: 0;
		padding: 24px;
		border-top: none;
		border-bottom: none;
		border-left: none;
		transition: transform 0.3s ease-in-out;
		z-index: 1000;
		border-right: 1px solid var(--background3);
		background-color: var(--background);
		transform: translate(100%, 0);
	}
	.open {
		transform: translate(0, 0);
	}
	.tabs {
		display: flex;
		align-items: center;
		margin-bottom: 32px;
	}
	.tab {
		padding: 8px 16px;
		border: none;
		color: var(--color);
		font-size: 0.9rem;
		margin-right: 8px;
		cursor: pointer;
	}
	.tab.selected{
		background-color: var(--color);
		color: var(--background);
	}
</style>
