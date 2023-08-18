<script>
    export let options;
    export let value;
    export let onChange;
    export let style;
	import { faCheck, faChevronDown, faPray } from "@fortawesome/free-solid-svg-icons";
    import Fa from "svelte-fa";
    let open = false;
    import { cubicInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers/clickOutside.js'

    function customAnimation(node, {duration, easing}) {
        return {
            css: t => {
                const eased = easing(t);
                return `
                    transform: scaleY(${eased}) translateY(-50%);
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
</script>
<style>
    .combobox{
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        position: relative;
    }
    .combobox-dialog{
        position: absolute;
        top: 50%;
        left: 0;
        width: 100%;
        border-radius: var(--border-radius);
        box-shadow: var(--box-shadow);
        z-index: 100;
        transform: translateY(-50%);
        background-color: #505050;
    }
    .combobox-option{
        padding: 0.7rem;
        cursor: pointer;
        background-color: #505050;
        display: grid;
        grid-template-columns: 25px 1fr;
    }
    .combobox-option:hover{
        background-color: var(--accent);
    }
</style>
<div use:clickOutside role={`Select element`} on:click={()=>{open=!open}} on:click_outside={()=>{open=false}} style={style} class="combobox">
    {#if options.find(o=>o.id===value)}
        {options.find((o)=>o.id===value).label}<Fa icon={faChevronDown}></Fa>
    {:else}
        <p style="margin:0;opacity:.5">Select option</p><Fa icon={faChevronDown}></Fa>
    {/if}
    {#if open}
    <div transition:customAnimation={{duration:350, easing:cubicInOut}} class="combobox-dialog">
        {#each options as option, i}
            <div role={`Element`} class="combobox-option" style={`border-radius:${i==options.length-1?"0 0 var(--border-radius) var(--border-radius)":i==0?"var(--border-radius) var(--border-radius) 0 0":"0"}`} on:click={()=>{handleChange(option.id)}}>
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
