<script>
	import { faCheck, faChevronDown, faCode, faCross, faL, faLongArrowRight, faPlus, faTimes } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
	import Combobox from "../../lib/components/Combobox.svelte";
    import {scale} from "svelte/transition";
	import { cubicInOut } from "svelte/easing";

    
	import { onMount } from "svelte";

    let ace;

    onMount(async() => {
        ace = await import('brace');
        await import('brace/mode/javascript');
        await import('brace/theme/tomorrow_night');
        let editor = ace.edit('code-editor');
            editor.getSession().setMode('ace/mode/javascript');
            editor.setTheme('ace/theme/tomorrow_night');
    });

    const blockchainOptions = [
        {
            id:"ETH",
            label:"Ethereum"
        },
        {
            id:"SOL",
            label:"Solana"
        },
        {
            id:"DOT",
            label:"Polkadot"
        },
        {
            id:"ADA",
            label:"Cardano"
        }
    ]

    const operationOptions = [
        {
            id:"Transfer",
            label:"Transfer"
        },
        {
            id:"Swap",
            label:"Swap"
        },
        {
            id:"Deposit",
            label:"Deposit"
        },
        {
            id:"Withdraw",
            label:"Withdraw"
        }
    ]

    let txblocks = [
        {
            blockchain:"ETH",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001"
        },
        {
            blockchain:"SOL",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001"
        }
    ]

    let textEditorOpen = false;

    function addOperation(){
        txblocks.push({
            blockchain:undefined,
            operation:undefined,
            receivingAddress:"",
            amount:""
        })
        txblocks = txblocks;
    }

    function freeze() {
        var top= window.scrollY;

        document.body.style.overflow= 'hidden';

        window.onscroll= function() {
            window.scroll(0, top);
        }
    }

    function unfreeze() {
        document.body.style.overflow= '';
        window.onscroll= null;
    }

    function funf()
    {
        if(typeof document == "undefined")
            return;
        if(textEditorOpen){
            freeze();

        }else{
            unfreeze();
        }
    }

    $:funf();

    let text = "";
</script>

<style>
    .text-editor-container{
        width: 100%;
        height: 100dvh;
        position: fixed;
        top: 0;
        left: 0;
        background-color: #101010;
        z-index: 1;
    }
    .text-editor-header{
        padding: 16px;
        background-color: #252525;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .text-editor{
        width: 100%;
        height: 100%;
        border: none;
        outline: none;
        resize: none;
        padding: 16px;
        font-size: 1rem;
    }
    hr{
        height: 1px;
        border: none;
        background-color: var(--border-color);
        margin: 0;
    }
    .txblock{
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
    }
    .txblock{
        padding: 16px 16px 24px;
    }
    .txblock-input{
        max-width: 100%;
    }
    .txblock-button{
        padding: .7rem;
        border-radius: var(--border-radius);
        background-color: #404040;
        color: white;
        font-size: 1rem;
        min-width: 40px;
    }
    .txblock-button:hover{
        background-color: var(--accent);
        cursor: pointer;
    }
    main{
        padding: 16px;
    }
    .remove-button{
        display: block;
        margin-left: auto;
        margin-right: 16px;
        margin-top: 0;
        margin-bottom: 16px;
        background-color: transparent;
        border:none;
        color: var(--accent-accessible);
        font-size: 1rem;
        text-decoration: underline;
        cursor: pointer;
    }
    .card-footer{
        display: flex;
        justify-content: space-between;
        text-align: center;
        background-color: #252525;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
    }
    .card-footer-button{
        width: 100%;
        text-align: center;
        padding: 16px;
    }
    .card-footer-button:hover{
        color: var(--accent);
        cursor: pointer;
        user-select: none;
    }
</style>

<div transition:scale={{
        duration: 350,
        easing: cubicInOut
    }} class="text-editor-container" style={`display:${textEditorOpen?"block":"none"};`}>
    <div class="text-editor-header">
        <h4 style="margin:0;">Code editor for crosschain transaction</h4>
        <div>
            <button class="txblock-button color-transition" style="margin-right:8px;"><Fa icon={faCheck}></Fa></button>
            <button on:click={()=>{textEditorOpen = false}} class="txblock-button color-transition"><Fa icon={faTimes}></Fa></button>
        </div>
    </div>
    <!--<textarea class="text-editor"></textarea>-->
    <div class="text-editor" id="code-editor"></div>
</div>

<main>
    <div class="card">
        <div class="card-header"><h4 style="margin: 0;">Crosschain transaction</h4></div>
        {#each txblocks as txblock, i}
            <div class="txblock">
                <div class="txblock-input">
                    <p class="label">Select blockchain</p>
                    <Combobox onChange={(v)=>{txblocks[i].blockchain = v}} options={blockchainOptions} value={txblock.blockchain}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Select operation</p>
                    <Combobox onChange={(v)=>{txblocks[i].operation = v}} options={operationOptions} value={txblock.operation}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Receiving address</p>
                    <input value={txblock.receivingAddress}/>
                </div>
                <div class="txblock-input">
                    <p class="label">Amount</p>
                    <input value={txblock.amount} style="width: 150px;"/>
                </div>
                <div class="txblock-input">
                    <p class="label">Code</p>
                    <button on:click={()=>{textEditorOpen = true}} class="txblock-button color-transition"><Fa icon={faCode}></Fa></button>
                </div>
            </div>
            {#if txblocks.length > 2}
                <button on:click={()=>{txblocks.splice(i, 1); txblocks=txblocks}} class="remove-button">Remove operation</button>
            {/if}
            <hr/>
        {/each}
        <div class="card-footer">
            <div role={`Add operation`} on:click={()=>{addOperation()}} class="card-footer-button color-transition" style="border-right:1px solid var(--border-color);"><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</div>
            <div class="card-footer-button color-transition">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></div>
        </div>
    </div>
</main>