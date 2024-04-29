import { MsgSendEncodeObject, StdFee } from "@cosmjs/stargate"

/**
 * `preparePay` parameters
 */
export interface IPayOptions {
	address: string;
	amount: number | string;
}

// IBC TRANSACTION //
export interface IBCTransaction {
	signerAddress: string;
	messages: MsgSendEncodeObject[];
	fee: StdFee;
	memo: string;
}
