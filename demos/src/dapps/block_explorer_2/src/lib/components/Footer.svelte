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
</script>
<style>
    .footer{
        padding: 16px 32px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
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
</style>
<div class="footer">
    <p class="companyname">//. kynesys</p>
    <div class="footer-links">
        {#each links as link}
            <a class="footer-link" href={link.url}>{link.label}</a>
        {/each}
    </div>
    <p>All rights reserved</p>
</div>
