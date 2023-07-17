"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var crosschain_support_1 = require("./crosschain_support");
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var eth_rpc, eth_address, eth_provider, eth_balance, btc_rpc, btc_address, btc_provider, btc_balance, sol_rpc, sol_address, sol_provider, sol_balance;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    eth_rpc = "http://eth.bandal.one:8545";
                    eth_address = "0x815eC3F291079Dd9dd7237f60ff0c8e70aEAf690";
                    return [4 /*yield*/, crosschain_support_1.default.evm.connect(eth_rpc)];
                case 1:
                    eth_provider = _a.sent();
                    return [4 /*yield*/, crosschain_support_1.default.evm.getBalance(eth_address)];
                case 2:
                    eth_balance = _a.sent();
                    console.log("Ethereum balance of ".concat(eth_address, ": ").concat(eth_balance));
                    btc_rpc = "http://144.178.132.34:8333";
                    btc_address = "16ftSEQ4ctQFDtVZiUBusQUjRrGhM3JYwe";
                    return [4 /*yield*/, crosschain_support_1.default.btc.connect(btc_rpc)];
                case 3:
                    btc_provider = _a.sent();
                    return [4 /*yield*/, crosschain_support_1.default.btc.getBalance(btc_address)];
                case 4:
                    btc_balance = _a.sent();
                    console.log("Bitcoin balance of ".concat(btc_address, ": ").concat(btc_balance));
                    sol_rpc = "https://api.mainnet-beta.solana.com";
                    sol_address = "CnP33htGVwKHF4psPq57QnRpiNTgKW58RyceytoX78n2";
                    return [4 /*yield*/, crosschain_support_1.default.solana.connect(sol_rpc)];
                case 5:
                    sol_provider = _a.sent();
                    return [4 /*yield*/, crosschain_support_1.default.solana.getBalance(sol_address)];
                case 6:
                    sol_balance = _a.sent();
                    console.log("Solana balance of ".concat(sol_address, ": ").concat(sol_balance));
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(console.error);
