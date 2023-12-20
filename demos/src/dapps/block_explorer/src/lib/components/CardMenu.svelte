<script>
    import {clickOutside} from "$lib/eventhandlers";
    import {toprightbudino} from "$lib/transitions";
    /** @typedef {{label:string, callback:any, icon:string}} menuItem*/
    /** @type {menuItem[]} */
    export let menuItems = [];  
    let menuopen = false;
</script>
        
<button on:click={()=>{menuopen = true;}} class="shallow color-transition"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={16}><g id="vertical-menu--navigation-vertical-three-circle-button-menu-dots"><path id="Union" fill="var(--color)" fill-rule="evenodd" d="M9 1h6v6H9V1Zm0 8h6v6H9V9Zm6 8H9v6h6v-6Z" clip-rule="evenodd"></path></g></svg></button>
{#if menuopen}
    <div use:clickOutside on:click_outside={()=>{menuopen = false}} transition:toprightbudino={{duration:200}} class="dialog">
        {#each menuItems as item}
        <button on:click={item.callback} class="dialog-option color-transition">
            <svg class="icon">{@html item.icon}</svg> 
            <p style="margin:0">{item.label}</p>
        </button>
        {/each}
    </div>
{/if}

<style>
    .dialog{
        position: absolute;
        top: 0;
        right: 0;
        background: var(--background3);
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--background3);
    }
    .dialog-option{
        padding: 16px;
        width: 100%;
        display: grid;
        grid-template-columns: 20px 1fr;
        align-items: center;
        gap: 8px;
        min-width: 150px;
        font-size: 1rem;
    }
    .dialog-option:hover{
        background-color: var(--color2);
        color: var(--background);
    }
    .dialog-option svg path{
        fill: var(--color2);
    }
    .dialog-option:hover svg path{
        fill: var(--background);
    }
    .icon{
        width: 16px;
        height: 16px;
    }
</style>