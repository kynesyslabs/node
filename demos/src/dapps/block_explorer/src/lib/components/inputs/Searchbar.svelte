<script>
	import { faArrowRightArrowLeft, faArrowRightLong, faRightLong, faSearch } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";

</script>
<style>
    .searchToken {
        margin: 50px auto 80px;
        max-width: 500px;
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
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.08) !important;
        backdrop-filter: blur(15px);
        padding: 0 60px 0 52px;
        height: 70px;
        color: #fff;
        font-size: 18px;
        font-weight: 400;
        line-height: 1.4444;
        letter-spacing: 0.311px;
        border: 0 !important;
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
        <Fa style="color:#A8ACAF;" icon={faSearch}/>
    </div>
    <input type="text" placeholder="Search for an hash"/>
    <button type="submit">
    <div>
        <Fa style="color:#A8ACAF; width: 100%; height: 100%; object-fit: contain;" icon={faArrowRightLong}/>
    </div>
    </button>
</form>