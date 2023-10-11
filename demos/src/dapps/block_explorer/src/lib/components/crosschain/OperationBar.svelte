<script>
    import { v4 as uuidv4 } from 'uuid';
    import DNDs from '$lib/components/crosschain/DNDs.svelte';
    import Fa from "svelte-fa";
	import { faChevronRight, faChevronLeft } from "@fortawesome/free-solid-svg-icons";

    const universal = [
        {id:uuidv4(), label:"Pay", type:"pay", data:null}, 
    ];

    const evm = [
        {id:uuidv4(), label:"Read contract", type:"contract_read", data:null}, 
        /*{id:uuidv4(), label:"Write contract", type:"contract_write", data:null}*/
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

    function closeMe()
    {
        mobilesidebaropen = false;
    }

    let mobilesidebaropen = false;
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
        transition: left .3s ease-in-out;
        z-index: 1000;
        border-right: 1px solid var(--background3);
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
    .minimizedsidebar{
        display: none;
        width: 10px;
        height: 100%;
        align-items: center;
        position: absolute;
        top: 0;
        right: 0;
    }
    .open-button{
        background-color: var(--accent);
        border-radius: 0 50% 50% 0;
        color: black;
        height: 32px;
        width: 32px;
        display: flex;
        justify-content: center;
        align-items: center;
        position: relative;
        left: 8px;
        transition: border-radius .5s ease-in-out;
    }
    @media screen and (max-width: 1120px)
    {
        .available-blocks{
            position: fixed;
            z-index: 1000;
            left: calc(-100% + 64px);
        }
        .open{
            left: 0;
            position: fixed;
            z-index: 1000;
        }
        .minimizedsidebar{
            display: flex;
        }
    }
</style>

<div class={`available-blocks ${mobilesidebaropen?"open":""}`}>
    <h4 style="margin-bottom: 32px;">Available blocks</h4>
    {#each availableBlocks as blocks}
        <div class="category">
            <h4 class="blocks-title">{blocks.label}</h4>
            <DNDs closeBar={closeMe} blocks={blocks.blocks}/>
        </div>
    {/each}
    <div class="minimizedsidebar">
        <button on:click={()=>{mobilesidebaropen=!mobilesidebaropen}} class="open-button" style={mobilesidebaropen?"border-radius:50%;":""}><Fa style="width:32px;" icon={mobilesidebaropen?faChevronLeft:faChevronRight}></Fa></button>
    </div>
</div>