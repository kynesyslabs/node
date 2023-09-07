<script>
	import { faArrowRightArrowLeft, faArrowRightLong, faRightLong, faSearch } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";

</script>
<style>
    .searchToken {
        margin: 50px auto 80px;
        position: relative;
    }

    .searchTokenIcon {
        font-size: 20.5px;
        fill: #A8ACAF;
        position: absolute;
        top: 50%;
        transform: translateY(-50%); 
        left: 22px;
        z-index: 1;
        pointer-events: unset;
    }


    .searchToken input {
        padding: 0 60px 0 52px;
        height: 70px;
        color: #fff;
        font-size: 18px;
        font-weight: 400;
        line-height: 1.4444;
        letter-spacing: 0.311px;
    }

    .searchToken input::placeholder {
        color: #545459;
    }

    .searchToken input:focus {
        box-shadow: unset;
    }

    .searchToken button {
        border: 0 !important;
        background: transparent !important;
        padding: 0;
        width: 24px;
        height: 24px;
        position: absolute;
        top: 50%;
        transform: translateY(-50%); 
        right: 22px;
        pointer-events: unset;
        font-size: 0;
        z-index: 1;
    }
    @media (max-width: 1399px){
        .searchToken {
            margin: 45px auto 70px;
            max-width: 480px;
        }
    
        .searchTokenIcon {
            font-size: 20px;
        }
        
        .searchToken input {
            height: 65px;
        }
    }
    @media (max-width:1199px)
    {
        .searchToken {
            margin: 40px auto 55px;
            max-width: 460px;
        }
    
        .searchTokenIcon {
            font-size: 20px;
        }
        
        .searchToken input {
            height: 62px;
            font-size: 17px;
        }
    }
    @media (max-width: 991px)
    {
        .searchToken {
            margin: 35px auto 50px;
            max-width: 460px;
        }
        
        .searchTokenIcon {
            font-size: 20px;
        }
        
        .searchToken input {
            height: 58px;
            font-size: 16px;
        }
    }
    @media (max-width: 767px)
    {
        .searchToken {
            margin: 30px auto 45px;
            max-width: 420px;
        }
        
        .searchTokenIcon {
            font-size: 20px;
            left: 18px;
        }
        
        .searchToken input {
            height: 52px;
            font-size: 16px;
            padding: 0 55px 0 50px;
            border-radius: 10px;
        }
        
        .searchToken button {
            right: 16px;
        }
    }
</style>

<form class="searchToken">
    <div class="searchTokenIcon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="24" width="24"><g id="magnifying-glass--glass-search-magnifying"><path id="Union" fill="#a8acaf" fill-rule="evenodd" d="M3.25 11a7.75 7.75 0 1 1 15.5 0 7.75 7.75 0 0 1 -15.5 0ZM11 0.75C5.34 0.75 0.75 5.34 0.75 11S5.34 21.25 11 21.25c2.38 0 4.57 -0.811 6.31 -2.172l3.806 3.806 1.768 -1.768 -3.806 -3.806A10.205 10.205 0 0 0 21.25 11C21.25 5.34 16.661 0.75 11 0.75Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    </div>
    <input type="text" placeholder="Search for an hash"/>
    <button type="submit">
    <div>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="24" width="24"><g id="end-point-arrow"><path id="Union" fill="#a8acaf" fill-rule="evenodd" d="m14.472 17.92 -1.819 1.212 0.692 -2.073L14.697 13H1v-2h13.698l-1.353 -4.059 -0.692 -2.073 1.82 1.212 7.943 5.296 0.936 0.624 -0.936 0.624 -7.944 5.296Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    </div>
    </button>
</form>