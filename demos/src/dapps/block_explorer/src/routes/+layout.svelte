<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte";
	import { fly } from "svelte/transition";
    export let data;
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
        overflow: hidden;
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
        {#key data.url}
        <div in:fly={{ x: 200, duration: 300, delay: 300 }} out:fly={{ x: -200, duration: 300 }}>
            <slot/>
        </div>
        {/key}
    </main>
    <Footer/>
</div>

