<script>
	import CopyButton from "$lib/components/CopyButton.svelte";
    import Fa from "svelte-fa";
	import { faQrcode, faTimes } from "@fortawesome/free-solid-svg-icons";
    import { cubicInOut } from 'svelte/easing';
	import QrCode from "$lib/components/QrCode.svelte";
	import TransactionGrid from "$lib/components/blockexplorer/TransactionGrid.svelte";

    export let data;

    let qropen=false;


    function customAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scale(${0.9 + eased/10});
                    opacity: ${eased};
                    transform-origin:center center;
                );`;
            }
        };
    }

</script>

<style>
    .container{
        padding: 16px;
    }
    .header{
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 16px;
    }
    .modal{
        position: fixed;
        top: 0;
        left: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100vw;
        height: 100dvh;
        background-color: rgba(0,0,0,0.75);
        z-index: 500;
    }
    .closebutton{
        position: absolute;
        top: 0;
        right: 0;
        background-color: var(--accent);
        border: none;
        color: black;
        font-size: 2rem;
        cursor: pointer;
        padding: 8px 16px;
    }
</style>

{#if qropen}
    <div transition:customAnimation={{duration:350, easing:cubicInOut}} class="modal">
        <QrCode data={data.address.native.address}></QrCode>
        <button on:click={()=>{qropen=false;}} class="closebutton"><Fa icon={faTimes}></Fa></button>
    </div>
{/if}
<div class="container">
    <div class="card header">
        <h3 style="margin:0;">Address</h3>
        <p style="margin:0;" class="wrapword">{data.address.native.address}</p>
        <CopyButton text={data.address.native.address}></CopyButton>
        <button on:click={()=>{qropen=true;}} class="small-button color-transition tooltip"><span class="tooltiptext">Show QR code</span><Fa icon={faQrcode}></Fa></button>
    </div>
    <TransactionGrid transactions={data.transactions}></TransactionGrid>
</div>