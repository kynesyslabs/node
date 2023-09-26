import { v4 as uuidv4 } from 'uuid';
import {getAllChains} from "evm-chains";
//THIS FILE CONTAINS NOCODE DATA FOR CROSSCHAIN TRANSACTION

class Operation{
    constructor({chain = null, subchain = null, is_evm = false, rpc = null, tasktype = null, taskparams = {}}){
        this.chain = chain;
        this.subchain = subchain;
        this.is_evm = is_evm;
        this.rpc = rpc;
        if(tasktype)
        {
            let emptyParams = {}
            tasks.find(task => task.id == tasktype).params.forEach(param => {
                emptyParams[param.id] = null;
            });
            this.task = {
                type: tasktype,
                params: emptyParams
            }
        }
        else this.task = {
            type: tasktype,
            params: taskparams
        }
    }
}

class Conditional{
    constructor(){
        this.operator = null;
        this.statement = "";
        this.callback = null;
    }
}

const blockIcons = [
    {id:"pay", icon:"/task-icons/wallet.svg"},
    {id:"contract_read", icon:"/task-icons/contract.svg"},
    {id:"contract_write", icon:"/task-icons/write.svg"},
    {id:"multiexample", icon:"/task-icons/browser-hash.svg"},
    {id:"conditional", icon:"/task-icons/curly-brackets.svg"},
]

//!!chains
const mychains = [
    {
        id:"btc",
        label:"Bitcoin",
        is_evm:false,
        token:"BTC",
        icon:"/crypto-icons/btc.svg",
    },
    {
        id:"eth",
        label:"Ethereum",
        is_evm:true,
        token:"ETH",
        icon:"/crypto-icons/eth.svg",
    },
    {
        id:"xrpl",
        label:"XRP Ledger",
        is_evm:false,
        token:"XRP",
        icon:"/crypto-icons/xrp.svg"
    },
    {
        id:"xlm",
        label:"Stellar Lumens",
        is_evm:false,
        token:"XLM",
        icon:"/crypto-icons/xlm.svg"
    },
    {
        id:"egld",
        label:"MultiversX",
        is_evm:false,
        token:"EGLD",
        icon:"/crypto-icons/egld.svg"
    },
]

const chains = mychains.concat(getAllChains().filter(c=>c.chainId!==1).map(c=>{
    return {
        id: uuidv4(),
        label: c.name,
        token: c.nativeCurrency.symbol,
        icon: null,
        is_evm: true
    }
}));

const tasks = [
    //pay
    {
        id:"pay",
        label:"Pay",
        constraints:[],
        icon:"/task-icons/wallet.svg",
        params:[
            {
                id:"to",
                label:"To",
                type:"address",
                required:true
            },
            {
                id:"amount",
                label:"Amount",
                type:"number",
                required:true
            }
        ]
    },
    //read contract
    {
        id:"contract_read",
        label:"Read Contract",
        constraints:["evm"],
        icon:"/task-icons/contract.svg",
        params:[
            {
                id:"address",
                label:"Address",
                type:"address",
                required:true
            },
            {
                id:"abi",
                label:"ABI",
                type:"json",
                required:false
            },
            {
                id:"method",
                label:"Method",
                type:"string",
                required:true
            },
            {
                id:"params",
                label:"Params",
                type:"json",
                required:true
            }
        ]
    },
    //write contract
    {
        id:"contract_write",
        label:"Write Contract",
        constraints:["evm"],
        icon:"/task-icons/write.svg",
        params:[
            {
                id:"address",
                label:"Address",
                type:"address",
                required:true
            },
            {
                id:"abi",
                label:"ABI",
                type:"json",
                required:false
            },
            {
                id:"method",
                label:"Method",
                type:"string",
                required:true
            },
            {
                id:"params",
                label:"Params",
                type:"json",
                required:true
            }
        ]
    }
]

//!!tasks for single chain operations
    //tasks for all single chains
const universalTasks = [
    {
        id:"pay",
        label:"Pay",
        params:[
            {
                id:"to",
                label:"To",
                type:"address",
                required:true
            },
            {
                id:"amount",
                label:"Amount",
                type:"number",
                required:true
            }
        ]
    }
]

    //tasks for evm chains
const evmTasks = [
    {
        id:"contract_read",
        label:"Read Contract",
        params:[
            {
                id:"address",
                label:"Address",
                type:"address",
                required:true
            },
            {
                id:"abi",
                label:"ABI",
                type:"json",
                required:false
            },
            {
                id:"method",
                label:"Method",
                type:"string",
                required:true
            },
            {
                id:"params",
                label:"Params",
                type:"json",
                required:true
            }
        ] 
    },
];

//!!tasks for multichain operations
const mUniversalTasks = [];
const mEvmTasks = [];

export {chains, tasks, universalTasks, evmTasks, mUniversalTasks, mEvmTasks, Operation, Conditional, blockIcons};