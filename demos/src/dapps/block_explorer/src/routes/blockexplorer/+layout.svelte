<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte"; 
    export let data;
</script>

<style>
    main{
        margin: 64px 0;
        flex: 1;
        overflow: hidden;
    }
    .content-container{
        max-width: 1440px;
        margin: auto;
        width: calc(100% - 48px);
    }
    @media screen and (max-width: 600px)
    {
        main{
            margin: 16px 0;
        }
    }
</style>

<div class="master-container">
<Header />
    <main>
        {#key data.url}
                <!--<div class="content-container" in:fly={{ x: 200, duration: 300, delay: 300 }} out:fly={{ x: -200, duration: 300 }}>-->
                <div class="content-container">
                    <slot/>
                </div>
        {/key}
    </main>
    <Footer/>
</div>

