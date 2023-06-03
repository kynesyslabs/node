cd node
export ADDRESS=$(grep -o '"address": *"[^"]*"' ./data/keystore/accountKeystore | grep -o '"[^"]*"$' | sed 's/"//g')
export PRIVATE_CONFIG=ignore
geth --datadir data \
	    --networkid 53550 --nodiscover --verbosity 5 \
	        --syncmode full \
		--allow-insecure-unlock \
		    --istanbul.blockperiod 5 --mine --miner.threads 1 --miner.gasprice 0 --emitcheckpoints \
		        --http --http.addr 0.0.0.0 --http.port 8545 --http.corsdomain "*" --http.vhosts "*" \
			    --ws --ws.addr 0.0.0.0 --ws.port 8546 --ws.origins "*" \
			        --http.api admin,eth,debug,miner,net,txpool,personal,web3,istanbul \
				    --ws.api admin,eth,debug,miner,net,txpool,personal,web3,istanbul \
				        --unlock ${ADDRESS} --allow-insecure-unlock --password ./data/keystore/accountPassword \
					    --port 30303
