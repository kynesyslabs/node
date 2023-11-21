<script>
	import CopyButton from "$lib/components/CopyButton.svelte";
    import Fa from "svelte-fa";
	import { faQrcode, faTimes } from "@fortawesome/free-solid-svg-icons";
    import { cubicInOut } from 'svelte/easing';
	import QrCode from "$lib/components/QrCode.svelte";
    import demos from '$lib/demos.js';
    import { rpcaddress } from '$lib/env.js';
    import CubeSpinning from "$lib/components/CubeSpinning.svelte"
	import TransactionRow from "../../TransactionRow.svelte";
    import PageTitle from "$lib/components/PageTitle.svelte";

    
    async function getAddress()
    {
        //questo lo usavo quando c'era la transaction grid
        //let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
        demos.connect($rpcaddress);
        if(!demos.connected)
        return;
        let addressinfo = await demos.getAddressInfo("b7535851d5b9ff67d1eea37c48e3062ee62bdb3ffb2f01ee4cf5812f84055f5b");
        console.log("address info", addressinfo);
        return addressinfo;
    }

    async function getTransactions(tx_list)
    {
        console.log("gettando la transazione. connectato? ", demos.connected, "tx_list: ", tx_list);
        if(!demos.connected)
        return;
        let transactions = [];
        transactions = Promise.all(tx_list.map((tx) => {
            return demos.getTxByHash(tx);
        })).then(values=>{
            return values;
        });
        console.log("transactions: ", transactions);
        return transactions;
    }

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

{#await getAddress()}
    <CubeSpinning/>
{:then address}
    {#if qropen}
        <div transition:customAnimation={{duration:350, easing:cubicInOut}} class="modal">
            <QrCode data={address.native.address}></QrCode>
            <button on:click={()=>{qropen=false;}} class="closebutton"><Fa icon={faTimes}></Fa></button>
        </div>
    {/if}
    <div class="container">
        <PageTitle>Address</PageTitle>
        <div class="header">
            <p style="margin:0;" class="wrapword">{address.native.address}</p>
            <CopyButton text={address.native.address}></CopyButton>
            <button on:click={()=>{qropen=true;}} class="small-button color-transition tooltip"><span class="tooltiptext">Show QR code</span><Fa icon={faQrcode}></Fa></button>
        </div>
        <div class="body">
            {#await getTransactions(address.native.tx_list)}
                <CubeSpinning/>
            {:then transactions}
                {#each transactions as transaction}
                    <TransactionRow transaction={transaction}/>
                {/each}
            {:catch}
                <p style="text-align: center;">Something went wrong</p>
            {/await}
        </div>
    </div>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}

<style>
    .header{
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: -34px;
        margin-bottom: 64px;
    }
    .body{
        margin: 128px 0 64px;
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
        background-color: var(--color2);
        border: none;
        color: var(--background);
        font-size: 2rem;
        cursor: pointer;
        padding: 8px 16px;
    }
</style>