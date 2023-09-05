<script>
    import Fa from "svelte-fa";
    import {faChevronDown} from "@fortawesome/free-solid-svg-icons";
    import { cubicInOut } from 'svelte/easing';
	import Searchbar from "$lib/components/inputs/Searchbar.svelte";
    import {getAllChains} from "evm-chains";
    import {chains} from "$lib/chainscript.js";
    import Fuse from 'fuse.js'
    export let value;
    export let onChange;
    let open = false;
    let searchMode = false;
    let searchResults;

    const fuse = new Fuse(chains, {keys: ["label", "token", "id"]});

    function search(pattern){
        searchResults = fuse.search(pattern);
        searchMode = true;
    }

    function setSearchMode(value){
        searchMode = value;
    }

    let options;
    $: if (!searchMode)
    {
        options = chains;
    }
    else
    {
        options = searchResults.map(sr=>{
            return sr.item;
        })
    }

    function dialogAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scale(${0.9 + eased/10});
                    transform-origin:center;
                );`;
            }
        };
    }
    function modalAnimation(node, {duration = 350, easing = cubicInOut}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    opacity: ${eased};
                    transform-origin:center;
                );`;
            }
        };
    }
    //console.log(getAllChains());
</script>

<style>
    .combobox{
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        position: relative;
        z-index: 200;
    }
    .modal-background{
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index:300;
        background-color: rgba(0,0,0,.5);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;

    }
    .modal-dialog{
        background: rgb(20, 20, 20);
        border: var(--border);
        border-radius: var(--border-radius);
        padding: var(--container-padding);
        width: 100%;
        max-width: 500px;
        cursor: default;
    }
    .chain-icon{
        width: 40px;
        height: 40px;
        border-radius: 50%;
        margin-right: 8px;
        border: rgba(255,255,255,.1) 1px solid;
    }
    .chain-icon-mini{
        width: 25px;
        height: 25px;
        border-radius: 50%;
        margin-right: 8px;
        border: rgba(255,255,255,.1) 1px solid;
    }
    @media (max-width: 767px) {
        .chain-icon{
            width: 35px;
            height: 35px;
        }
    }
    @media (max-width: 575px)
    {
        .chain-icon{
            width: 30px;
            height: 30px;
        }
    }
    .chain-label{
        margin: 0;
    }
    .token-label{
        margin: 0;
        opacity: .5;
        font-size: .8rem;
    }
    .chain-options{
        margin-top: 16px;
    }
    .chain-option{
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        border-radius: 8px;
        padding: var(--input-padding) 0;
        width: 100%;
        transition: padding .2s ease-in-out, background-color .2s ease-in-out, color .2s ease-in-out;
    }
    .chain-option:hover{
        background-color: var(--accent);
        padding: var(--input-padding);
        color: black;
    }
    .selected-chain{
        display: flex;
        align-items: center;
        gap: 2px;
    }
</style>

{#if open}
<button on:click={()=>{open=false}} transition:modalAnimation={{
    duration: 350,
    easing: cubicInOut
}} class="modal-background">
    <button transition:dialogAnimation={{
        duration: 350,
        easing: cubicInOut
    }} class="modal-dialog" on:click={(ev)=>{ev.stopPropagation();}}>
        <h3>Select a blockchain</h3>
        <Searchbar {setSearchMode} onChange={search} hidesubmit={true} style="margin:0;" prompt="Search for a blockchain"/>
        {#if searchMode}
            <p style="margin-bottom:0">{searchResults.length} results</p>
        {/if}
        <div class="chain-options">
            {#each options as chain}
                <button on:click={()=>{onChange(chain.id); open=false;}} class="chain-option">
                    <img class="chain-icon" src={chain.icon} alt={chain.label}/>
                    <div>
                        <p class="chain-label">{chain.label}</p>
                        <p class="token-label">{chain.token}</p>
                    </div>
                </button>
            {/each}
        </div>
    </button>
</button>
{/if}
<button class="combobox" on:click={()=>{open = true}}>
    {#if !value}
    <p class="ellipsis" style="margin:0;opacity:.5">Select option</p>
    {:else}
    <div class="selected-chain">
        <img class="chain-icon-mini" src={chains.find(c=>c.id === value).icon} alt={chains.find(c=>c.id === value).label}/>
        <p class="ellipsis" style="margin:0;">{chains.find(c=>c.id === value).label}</p>
    </div>
    {/if}
    <Fa icon={faChevronDown}></Fa>
</button>