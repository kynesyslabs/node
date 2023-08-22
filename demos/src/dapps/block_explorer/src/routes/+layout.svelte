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
</style>


<Header />
<div class="wrapper">
    <main style="margin:128px 0;flex:1;">
        <slot/>
    </main>
    <Footer/>
</div>

