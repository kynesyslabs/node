<script>
    import { blockIcons} from '$lib/chainscript.js';
    export let addNode;
    export let open;
    export let closeDrawer;
</script>
<style>
    .drawer{
        max-width: 616px;
        height: 100dvh;
        position: fixed;
        right: 0;
        top: 0;
        padding: 24px;
        border-top: none;
        border-bottom: none;
        border-left: none;
        transition: transform .3s ease-in-out;
        z-index: 1000;
        border-left: 1px solid var(--background3);
        background-color: var(--background);
        transform: translate(100%, 0);
    }
    .open{
        transform: translate(0, 0);
    }
    .category{
        margin-bottom: 32px;
    }
    .blocks-title{
        opacity: .6;
    }
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
    }
    .taskicon{
        width: 24px;
        height: 24px;
    }
</style>
<div class={`drawer ${open?"open":""}`}>
    <h4 style="margin-bottom: 32px;">Available blocks</h4>
    <div class="category">
        <h4 class="blocks-title">Universal Tasks</h4>
        <button on:click={()=>{addNode(); closeDrawer();}} class="card operation">
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={blockIcons.find(item => item.id == "pay").icon}/>
            Pay
        </button>
    </div>
    <div class="category">
        <h4 class="blocks-title">EVM Tasks</h4>
        <div class="card operation">    
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={blockIcons.find(item => item.id == "contract_read").icon}/>
            Read Contract
        </div>
    </div>
    <div class="category">
        <h4 class="blocks-title">Logic</h4>
        <div class="card operation">
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={blockIcons.find(item => item.id == "conditional").icon}/>
            IF Statement
        </div>
        <div class="card operation">
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={"/task-icons/equal-sign.svg"}/>
            Condition Equals
        </div>
    </div>
</div>