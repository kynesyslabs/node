<script>
    export let options;
    export let value;
    export let onChange;
    export let style;
	import { faCheck, faChevronDown } from "@fortawesome/free-solid-svg-icons";
    import Fa from "svelte-fa";
    let open = false;
    import { cubicInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers/clickOutside.js'

    function comoboxAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scaleY(${0.8 + eased/5});
                    opacity: ${eased};
                    transform-origin:top center;
                );`;
            }
        };
    }


    function handleChange(newvalue)
    {
        value=newvalue;
        onChange(newvalue);
    }

    $:if(!options){options = []}
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
    .combobox-dialog{
        position: absolute;
        left: 0;
        width: 100%;
        border-radius: 8px;
        box-shadow: var(--box-shadow);
        z-index: 300;
        background-color: #505050;
        top: 0;
    }
    .combobox-option{
        padding: 8px;
        cursor: pointer;
        background-color: #505050;
        display: grid;
        grid-template-columns: 25px 1fr;
        position: relative;
        z-index: 500;
    }
    .combobox-option:hover{
        background-color: var(--accent);
        color: black;
    }
</style>

<div style="position: relative; max-width:100%">
    <div use:clickOutside role={`Select element`} on:click={()=>{open=!open}} on:click_outside={()=>{open=false}} style={style} class="combobox">
        {#if options.find(o=>o.id===value)}
            <p style="margin:0" >{options.find((o)=>o.id===value).label}</p><Fa icon={faChevronDown}></Fa>
        {:else}
            <p class="ellipsis" style="margin:0;opacity:.5">Select option</p><Fa icon={faChevronDown}></Fa>
        {/if}
    </div>
    {#if open}
    <div transition:comoboxAnimation={{duration:200, easing:cubicInOut}} id="dialog" class="combobox-dialog">
        {#each options as option, i}
            <div role={`Element`} class="combobox-option" style={`border-radius:${options.length==1?"var(--border-radius-alt)":i==options.length-1?"0 0 var(--border-radius-alt) var(--border-radius-alt)":i==0?"var(--border-radius-alt) var(--border-radius-alt) 0 0":"0"}`} on:click={()=>{handleChange(option.id)}}>
                {#if option.id===value}
                <Fa icon={faCheck}></Fa>
                {:else}
                <div></div>
                {/if}
                {option.label}
            </div>
        {/each}
    </div>
    {/if}
</div>