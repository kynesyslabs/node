<script>
    import { v4 as uuidv4 } from 'uuid';
    import {Operation, Conditional} from '$lib/chainscript.js';
    import DNDs from '$lib/components/crosschain/DNDs.svelte';

    const universal = [
        {id:uuidv4(), label:"Pay", type:"pay", data:null}, 
    ];

    const evm = [
        {id:uuidv4(), label:"Read contract", type:"contract_read", data:null}, 
        {id:uuidv4(), label:"Write contract", type:"contract_write", data:null}
    ]

    /*const multichain = [
        {id:uuidv4(), label:"Multiexample", data: new Operation({tasktype:"multiexample"})},
    ]*/

    const logic = [
        {id:uuidv4(), label:"Conditional statement", type:"conditional", condition:[], symbol:"equals", input:"",  then:[], else:[], data:null},
    ]

    const availableBlocks = [
        {label:"Universal tasks", blocks:universal},
        {label:"EVM tasks", blocks:evm},
        {label:"Logic", blocks:logic},
    ]
</script>

<style>
    .available-blocks{
        max-width: 616px;
        height: 100dvh;
        position: sticky;
        top: 0;
        padding: 24px;
        border-top: none;
        border-bottom: none;
        border-left: none;
    }
    .available-blocks h4{
        margin: 0 0 8px;
    }
    .category{
        margin-bottom: 32px;
    }
    .blocks-title{
        opacity: .6;
    }
</style>

<div class="card available-blocks">
    <h4 style="margin-bottom: 32px;">Available blocks</h4>
    {#each availableBlocks as blocks}
        <div class="category">
            <h4 class="blocks-title">{blocks.label}</h4>
            <DNDs blocks={blocks.blocks}/>
        </div>
    {/each}
</div>