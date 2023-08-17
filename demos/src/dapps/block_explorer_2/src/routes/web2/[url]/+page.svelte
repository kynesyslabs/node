<script>
    import '$lib/global.css';
    import demos from '$lib/demos';
    export let data;
    import Fa from 'svelte-fa'
    import { faArrowLeftLong, faArrowRightLong, faChevronLeft, faChevronRight, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
    import Footer from '$lib/components/Footer.svelte';
	import Header from '$lib/components/Header.svelte';
    let selectedTab = 0;
    function changeTab(index){
        selectedTab = index;
    }
    const rpc = "http://85.208.48.187:53550";

    demos.connect(rpc);

    demos.getWeb2Data().then((result) => {
        console.log(result);
    });
</script>