<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte"; 
	import OperationBar from "$lib/components/crosschain/OperationBar.svelte";
    let mobilesidebaropen = true;
</script>

<style>
    .thegrid{
        display: grid;
        grid-template-columns: auto 1fr;
    }
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
    @media screen and (max-width: 990px)
    {
        .thegrid{
            grid-template-columns: 1fr;
        }
        .sidebar{
            position: fixed;
            z-index: 1000;
            left: -100%;
        }
        .open{
            left: 0;
        }
    }
</style>

<div class="thegrid">
    <div class={`sidebar  ${mobilesidebaropen?"open":""}`}>
        <OperationBar/>
    </div> 
    <div style="padding:0 24px;">
        <Header />
        <div class="wrapper">
            <main>
                <slot/>
            </main>
            <Footer/>
        </div>
    </div>
</div>