// INFO: These are testnet wallets for each chain
export const wallets = {
	egld: {
		wallet: JSON.stringify({
			version: 4,
			id: 'c98cefdb-5ea0-404b-96b5-54391fe7cd68',
			kind: 'mnemonic',
			crypto: {
				ciphertext:
					'54067052dd60c0fc270329c5e3facfd0d16a5fe618a0ade72eb5797ca529b7b8808439d7d595b1c052e9684681efcb846e373b7f79fa2b6364618bffbc4afe50f20a510f00f7971e05516353ba225fcfe0a5d04d1995fc9e02ab242d60df838acfe59b5140d89adb00f88c121ad1a3cac3809d06bd025fad30fb3035374e8a80b20fb72d777b7b59182c75203f73b49265d8558b003814ea68dced49113d406216',
				cipherparams: { iv: '01710d9d92c8b45f2e02079ff3e2b58d' },
				cipher: 'aes-128-ctr',
				kdf: 'scrypt',
				kdfparams: {
					dklen: 32,
					salt: '10f68326bdd2755058dda807f9b3347e01b037ae65b439f0b0df1744fe4ff9d2',
					n: 4096,
					r: 8,
					p: 1
				},
				mac: 'dd63b26356692e206f25b7a034babe5a00705bdc7e3acaa2993733f930052489'
			}
		}),
		password: 'e9r#PNK7pB#?f39A'
	},
	xrpl: {
		wallet: 'sEdToEm3WLYXRmhvs62pd1BuLfxF9WG'
	},
	evm: {
		// INFO: Sepolia testnet wallet 👇
		wallet: 'e0a00e307c21850cde41b18bae307a492c471b463b60ce5b631fdb80503b23f7'
	},
	ibc: {
		// INFO: Cosmos chain Id: "theta-testnet-001"
		wallet: 'stumble august fancy affair device feed cruise brown dream section fit lift'
	}
};

export const addresses = {
	// Alt account
	// INFO: XRPL doesn't accept transfers to own account
	xrpl: 'rE57JVcMmoNq6yNbBbiJrCY9sMr4HWiqwf'
};
