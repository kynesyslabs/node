#!/bin/bash
# Environmental awareness
export DEMOS_PORT=53550
export EVM_RPC=8545
export EVM_WS=8546
export KYN_HTTP=80
export KYN_HTTPS=443
export KYN_P2P=30303
export KYN_RAFT=53000
# Docker run
docker run \
	--name $(cat name) \
	-v $(pwd)/evm:/usr/src/app/evm \
	-v $(pwd)/demos:/usr/src/app/demos \
	-v $(pwd)/common:/usr/src/app/common \
	-p $DEMOS_PORT:53550 \
	-p $EVM_RPC:8545 \
	-p $EVM_WS:8546 \
	-p $KYN_HTTP:80 \
	-p $KYN_HTTPS:443 \
	-p $KYN_P2P:30303 \
	-p $KYN_RAFT:53000 \
	-it -d kyntainer
# Resetting environment variables
export DEMOS_PORT=""
export EVM_RPC=""
export EVM_WS=""
export KYN_HTTP=""
export KYN_HTTPS=""
