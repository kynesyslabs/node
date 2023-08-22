<script>
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
        padding: 16px 32px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        background-color: rgb(20, 20, 20);
        margin-top: auto;
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
        font-family: 'HelveticaN';
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
<div class="background">
</div>
<div class="footer">
    <p class="companyname">//. kynesys</p>
    <div class="footer-links">
        {#each links as link}
            <a class="footer-link" href={link.url}>{link.label}</a>
        {/each}
    </div>
    <p>All rights reserved</p>
</div>