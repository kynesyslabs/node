<script>
    import Fa from "svelte-fa";
    import {faChevronDown} from "@fortawesome/free-solid-svg-icons";
	import Searchbar from "$lib/components/inputs/Searchbar.svelte";
    import {chains} from "$lib/chainscript.js";
    //click outside event
    import { clickOutside } from '$lib/eventhandlers.js';
    import Fuse from 'fuse.js'

    export let value;
    export let onChange;
    let open = false;
    export let onOpen;
    export let evmTask;

    let searchMode = false;
    let searchResults;

    const fuse = new Fuse(evmTask?chains.filter(c=>c.is_evm):chains, {keys: ["label", "token", "id"]});

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
        options = evmTask?chains.filter(c=>c.is_evm).slice(0,5):chains.slice(0,5);
    }
    else
    {
        options = searchResults.map(sr=>{
            return sr.item;
        })
    }
</script>

<div>
    <div class="combobox" on:click={()=>{open = true}}>
        {#if !value}
        <p class="ellipsis" style="margin:0;opacity:.5">Select chain</p>
        {:else}
        <div class="selected-chain">
            {#if chains.find(c=>c.id === value).icon}
                <img class="chain-icon-mini" src={chains.find(c=>c.id === value).icon} alt={chains.find(c=>c.id === value).label}/>
            {/if}
            <p class="ellipsis" style="margin:0; margin-top:2px;">{chains.find(c=>c.id === value).label}</p>
        </div>
        {/if}
        <Fa icon={faChevronDown}></Fa>
        {#if open}
            <div class="chain-selection" on:click={(ev)=>{ev.stopPropagation();}} use:clickOutside on:clickOutside={()=>{open=false;}}>
                <Searchbar {setSearchMode} onChange={search} hidesubmit={true} style="margin:0; background-color:var(--background); border-top: none; border-left:none;border-right:none;" prompt="Search for a blockchain"/>
                {#if searchMode}
                    <p style="margin-bottom:0">{searchResults.length} results</p>
                {/if}
                <div class="chain-options">
                    {#each options as chain}
                        <button disabled={chain.disabled} on:click={(ev)=>{ev.stopPropagation(); onChange(chain.id); open=false;}} class="chain-option" style={`${chain.disabled?"opacity:.2":""}`}>
                            {#if chain.icon}
                                <img class="chain-icon" src={chain.icon} alt={chain.label}/>
                            {/if}
                            <div>
                                <p class="chain-label">{chain.label}</p>
                                <p class="token-label">{chain.token}</p>
                            </div>
                        </button>
                    {/each}
                </div>
            </div>
        {/if}
    </div>
</div>

<style>
    .combobox{
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        position: relative;
        z-index: 200;
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
        margin: 0 0 4px;
        font-size: 1rem;
    }
    .token-label{
        margin: 0;
        opacity: .5;
        font-size: .8rem;
    }
    .chain-options{
        padding: 24px;
    }
    .chain-option{
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: var(--input-padding) 0;
        width: 100%;
        transition: padding .2s ease-in-out, background-color .2s ease-in-out, color .2s ease-in-out;
        
    }
    .chain-option:hover:not(:disabled){
        background-color: var(--color2);
        padding: var(--input-padding);
        color: var(--background);
    }
    .selected-chain{
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .chain-selection{
        position: absolute;
        top: 0;
        width: 100%;
        left: 0;
        background-color: var(--background2);
    }
</style>