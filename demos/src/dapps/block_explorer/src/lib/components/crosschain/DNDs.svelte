<script>
    import {dndzone, TRIGGERS, SHADOW_ITEM_MARKER_PROPERTY_NAME} from "svelte-dnd-action";
    import { blockIcons} from '$lib/chainscript.js';
    import { v4 as uuidv4 } from 'uuid';
    import cloneDeep from 'lodash/cloneDeep';
    export let blocks;
    export let closeBar;
    let availableBlocks = [...blocks];

    let shouldIgnoreDndEvents = false;
    function considerAvailable(e)
    {
        closeBar();
        //console.warn(`got consider ${JSON.stringify(e.detail, null, 2)}`);
        const {trigger, id} = e.detail.info;
        if (trigger === TRIGGERS.DRAG_STARTED) {
            //console.warn(`copying ${id}`);
            const idx = availableBlocks.findIndex(item => item.id === id);
            const newId = uuidv4();
			e.detail.items = e.detail.items.filter(item => !item[SHADOW_ITEM_MARKER_PROPERTY_NAME]);
            e.detail.items.splice(idx, 0, {...availableBlocks[idx], id: newId});
            availableBlocks = cloneDeep(e.detail.items);
            shouldIgnoreDndEvents = true;
        }
        else if (!shouldIgnoreDndEvents) {
            availableBlocks = e.detail.items;
        }
        else {
            availableBlocks = [...availableBlocks];
        }
    }

    function finalizeAvailable(e)
    {
        if (!shouldIgnoreDndEvents) {
            availableBlocks = e.detail.items;
        }
        else {
            availableBlocks = [...availableBlocks];
            shouldIgnoreDndEvents = false;
        }
    }
</script>

<style>
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .dnd{
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-rows: 1fr;
        gap: 16px;
    }
</style>

<div class="dnd" use:dndzone={{items:availableBlocks, dropFromOthersDisabled:true, morphDisabled:true, centreDraggedOnCursor:true}} on:consider={considerAvailable} on:finalize={finalizeAvailable}>
    {#each availableBlocks as block(block.id)}
        <div class="card operation">
            <img style="opacity: .3;" alt="task icon" src={blockIcons.find(item => item.id == block.type).icon}/>
            {block.label}
        </div>
    {/each}
</div>