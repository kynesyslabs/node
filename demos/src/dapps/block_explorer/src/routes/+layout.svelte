<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte";
</script>

<style>
    .wrapper{
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
    }
    main{
        margin: 64px 0;
        flex: 1;
    }
    @media screen and (max-width: 600px)
    {
        main{
            margin: 16px 0;
        }
    }
</style>


<Header />
<div class="wrapper">
    <main>
        <slot/>
    </main>
    <Footer/>
</div>

