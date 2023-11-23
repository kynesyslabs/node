<script>
    export let options;
    export let value;
    export let onChange;
    export let style;
	import { faCheck, faChevronDown } from "@fortawesome/free-solid-svg-icons";
    import Fa from "svelte-fa";
    import { cubicInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers.js';
    let open = false;
    let disabled = false;

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

    $:if(!options)
    {options = []}
    $:if(options.length == 1)
    {
        value = options[0].id;
        handleChange(options[0].id);
        disabled = true;
    }
    else
    {
        disabled = false;
    }
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
        box-shadow: var(--box-shadow);
        z-index: 300;
        background-color: var(--background3);
        top: 0;
    }
    .combobox-option, .disabled-option{
        padding: 0 var(--input-padding);
        height: 52px;
        cursor: pointer;
        background-color: var(--background3);
        display: grid;
        grid-template-columns: 25px 1fr;
        position: relative;
        z-index: 500;
        font-size: 1rem;
        align-items: center;
    }
    .disabled-option{
        opacity: .4;
        border-radius: 0;
    }
    .combobox-option:hover{
        background-color: var(--color2);
        color: var(--background);
    }
</style>

<div style="position: relative; max-width:100%">
    <div use:clickOutside role={`Select element`} on:click={()=>{if(!disabled)open=!open}} on:click_outside={()=>{open=false}} style={style} class={`combobox smallcombobox`}>
        {#if options.length == 1}
            <div>
                <p>{options[0].label}</p>
            </div>
        {:else if options.find(o=>o.id===value)}
            <p style="margin:0" >{options.find((o)=>o.id===value).label}</p><Fa icon={faChevronDown}></Fa>
        {:else}
            <p class="ellipsis" style="margin:0;opacity:.5">Select option</p><Fa icon={faChevronDown}></Fa>
        {/if}
    </div>
    {#if open}
    <div transition:comoboxAnimation={{duration:200, easing:cubicInOut}} id="dialog" class="combobox-dialog">
        {#each options as option, i}
            <div role={`Element`} class={option.disabled?"disabled-option":"combobox-option"} on:click={option.disabled?()=>{}:()=>{handleChange(option.id)}}>
                {#if option.id===value}
                <Fa icon={faCheck}></Fa>
                {:else if option.disabled}
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16"><g id="padlock-square-1--combination-combo-lock-locked-padlock-secure-security-shield-keyhole"><path id="Union" fill="var(--color)" fill-rule="evenodd" d="M8 7a4 4 0 1 1 8 0v3H8V7Zm-2 3V7a6 6 0 1 1 12 0v3h3v13H3V10h3Zm5 8.5v-4h2v4h-2Z" clip-rule="evenodd"></path></g></svg>
                {:else}
                <div></div>
                {/if}
                {option.label}
            </div>
        {/each}
    </div>
    {/if}
</div>