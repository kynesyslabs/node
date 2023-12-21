<script>
    const links = [
        {
            label: "DOCS",
            url: "https://uploads-ssl.webflow.com/637666f7c0a45f6ef07fab12/64b5bebfccca8da619a1ea72_DEMOS%20Yellow%20Paper.pdf"
        },
        {
            label:"X",
            url:"https://twitter.com/KynesysLabs"
        }
    ]
</script>
<style>
    .footer{
        max-width: 1440px;
        margin: 0 auto;
        width: calc(100% - 48px);
        display: grid;
        align-items: center;
        grid-template-columns: 1fr 1fr 1fr;
        margin-top: 64px;
        border-top: 1px solid var(--background3);
        padding: 40px 0;
    }
    @media screen and (max-width: 768px){
        .footer{
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 16px;
        }
    }
    .footer-links{
        display: flex;
        gap: 16px;
        justify-content: center;
    }
    .footer-link-container{
        color:var(--color);
        font-weight: 100;
        padding: 0 32px;
    }
    .arrow{
        transform: rotate(181deg);
    }

    .footer-link{
        color: var(--color);
        text-decoration: none;
        font-size: 1rem;
        font-weight: 100;
        cursor: pointer;
        height: 100%;
        display: flex;
        align-items: center;
        position: relative;
    }
    .footer-link::after{
        content: "";
        display: block;
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 1px;
        background: var(--color2);
        transform: scaleX(0);
        transition: transform .3s ease;
        transform-origin: left;
    }
    .footer-link:hover::after{
        transform: scaleX(1);
    }
    .footer-link-container:not(:last-child){
        border-right: 1px solid var(--background2);
    }
</style>

<div class="footer">
    <svg class="arrow" width="45" height="45" viewBox="0 0 45 45" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.08294 3.61158L7.72346 3.915L6.67399 33.1931L39.7929 0.0741859L44.9254 5.20667L11.8065 38.3256L41.0846 37.2761L41.388 43.9167L0.79083 44.5107L0.488918 44.2088L1.08294 3.61158Z" fill="var(--background3)"/>
    </svg>
    <div class="footer-links">
        {#each links as link}
            <div class="footer-link-container">
                <a class="footer-link" href={link.url}>{link.label}</a>
            </div>
        {/each}
    </div>
    <div class="footer-link-container" style="margin-left: auto;">
        <a href="/settings" class="footer-link">Settings</a>
    </div>
</div>