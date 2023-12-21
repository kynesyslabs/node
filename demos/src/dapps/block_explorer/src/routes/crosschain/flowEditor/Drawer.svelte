<script>
	import AvailableBlocks from "./AvailableBlocks.svelte";
	import Execute from "./Execute.svelte";
	import Fa from "svelte-fa";
	import { faChevronRight, faChevronLeft, faTimes } from "@fortawesome/free-solid-svg-icons";
	let tab = "blocks";
	export let required_connections;
	function closeMe()
    {
        mobilesidebaropen = false;
    }

    let mobilesidebaropen = false;
</script>
<aside class={`drawer ${mobilesidebaropen?"open":""}`}>
	<div class="tabs">
		<button class={`tab ${tab=="blocks"?"selected":""}`} on:click={()=>{tab="blocks"}}>Blocks</button>
		<button class={`tab ${tab=="execute"?"selected":""}`} on:click={()=>{tab="execute"}}>Execute</button>
		<button style="margin-left:auto" on:click={()=>{mobilesidebaropen=false}}><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={16} ><g id="delete-1--remove-add-button-buttons-delete-cross-x-mathematics-multiply-math"><path id="Union" fill="var(--color)" fill-rule="evenodd" d="m12 14.828 9.086 9.086 2.828-2.828L14.828 12l9.086-9.086L21.086.086 12 9.17 2.914.086.086 2.914 9.172 12 .086 21.086l2.828 2.828L12 14.828Z" clip-rule="evenodd"></path></g></svg></button>
	</div>
	{#if tab == "blocks"}
    <AvailableBlocks closeDrawer={closeMe}></AvailableBlocks>
	{:else if tab == "execute"}
	<Execute {required_connections}></Execute>
	{/if}

</aside>
<div class="minimizedsidebar">
	<button on:click={()=>{mobilesidebaropen=!mobilesidebaropen}} class="open-button" style={mobilesidebaropen?"border-radius:50%;":""}><Fa style="width:32px;" icon={mobilesidebaropen?faChevronLeft:faChevronRight}></Fa></button>
</div>

<style>
	.drawer {
		max-width: 429px;
		height: 100%;
		position: absolute;
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
		transform: translate(-100%, 0);
		overflow: hidden;
		overflow-y : scroll;
	}
	.drawer.open {
		transform: translate(0, 0);
	}
	.open-button{
        background-color: var(--color2);
        border-radius: 0 50% 50% 0;
        color: var(--background);
        height: 32px;
        width: 32px;
        display: flex;
        justify-content: center;
        align-items: center;
        position: relative;
        left: 0;
        transition: border-radius .5s ease-in-out;
    }
	.minimizedsidebar{
        display: none;
        width: 10px;
        height: 100%;
        align-items: center;
        position: fixed;
        top: 0;
        left: 0;
    }
		.minimizedsidebar{
			display: flex;
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
