#!/bin/bash

git clone https://github.com/ethereum-lists/chains
rm -rf ../../data/evmChains
mv chains/_data/chains ../../data/evmChains
rm -rf chains
