<script>
	import RPCselection from "$lib/components/inputs/RPCselection.svelte";
    const links = [
        {
            label: "DOCS",
            url: "https://uploads-ssl.webflow.com/637666f7c0a45f6ef07fab12/64b5bebfccca8da619a1ea72_DEMOS%20Yellow%20Paper.pdf"
        },
        {
            label:"TWITTER",
            url:"https://twitter.com/KynesysLabs"
        }
    ]

    import "$lib/assets/backgrounds/bubblesbg.jpeg";
</script>
<style>

    .footer{
        max-width: 1440px;
        margin: 16px auto;
        width: calc(100% - 48px);
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        margin-top: auto;
        gap: 0 32px;
    }
    .footer-links{
        display: flex;
        gap: 16px;
    }
    .footer-link{
        color:white;
        font-weight: bold;
    }
    .companyname{
        font-weight: bold;
        font-size: 1.2rem;
        font-family: 'Helvetica Neue';
    }
    .background-blur{
        position: fixed;
        /*background-color: rgba(20, 20, 20, 0.5);*/
        background-color: black;
        backdrop-filter: blur(40px);
        height: 100dvh;
        width: 100%;
        z-index: -1;
        bottom: 0;
    }
    .background{
        position: fixed;
        background: url("/backgrounds/bubblesbg.jpg") no-repeat center center;
        background-size: cover;
        height: 100dvh;
        width: 100%;
        z-index: -2;
        bottom: 0;
    }
</style>
<div class="background-blur">
</div>

<div class="background">
</div>
<div class="footer">
    <p class="companyname">//. kynesys</p>
    <div class="footer-links">
        {#each links as link}
            <a class="footer-link" href={link.url}>{link.label}</a>
        {/each}
    </div>
    <RPCselection/>
    <p>All rights reserved</p>
</div>