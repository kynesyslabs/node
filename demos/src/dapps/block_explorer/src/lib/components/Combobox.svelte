<script>
    export let options;
    export let value;
	import { faCheck, faChevronDown, faPray } from "@fortawesome/free-solid-svg-icons";
    import Fa from "svelte-fa";
    let open = false;
    import { fade, scale } from 'svelte/transition';
    import { cubicInOut, elasticInOut, elasticOut, quadInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers/clickOutside.js'

    function customAnimation(node, { delay, duration, easing, x, y, opacity }) {
        return {
            delay,
            duration,
            easing,
            css: t => {
                const eased = cubicInOut(t);
                return `
                    transform: scaleY(${eased}) translateY(-50%);
                    opacity: ${eased};
                    transform-origin:top center;
                );`;
            }
        };
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
        z-index: 1;
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
<div use:clickOutside role={`Select element`} on:click={()=>{open=!open}} on:click_outside={()=>{open=false}} class="combobox">
    {options.find((o)=>o.id===value).label}<Fa icon={faChevronDown}></Fa>
    {#if open}
    <div transition:customAnimation={{duration:400, easing:quadInOut}} class="combobox-dialog">
        {#each options as option, i}
            <div role={`Element`} class="combobox-option" style={`border-radius:${i==options.length-1?"0 0 var(--border-radius) var(--border-radius)":i==0?"var(--border-radius) var(--border-radius) 0 0":"0"}`} on:click={()=>{value=option.id}}>
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
