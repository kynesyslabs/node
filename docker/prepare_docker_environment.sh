#!/bin/bash
# NOTE This extra simple script just creates a copy of the repository you are (or should be) in, in the docker folder.
# This is done to always have a copy of the repository in the docker folder, so that the docker image is able to work
# on its own.
cd ..
mkdir -p docker/node_1
rsync -av --exclude=node_modules --exclude=docker --exclude=.trunk --exclude=.vscode \
          --exclude=demos_peers --exclude=.demos_identity --exclude=/data/chain.db --exclude=pubkey \
          --exclude=.git \
           ./ ./docker/node_1
mkdir -p docker/node_2
rsync -av --exclude=node_modules --exclude=docker --exclude=.trunk --exclude=.vscode \
          --exclude=demos_peers --exclude=.demos_identity --exclude=/data/chain.db --exclude=pubkey \
          --exclude=.git \
           ./ ./docker/node_2