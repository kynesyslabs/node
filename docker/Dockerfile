# trunk-ignore-all(trivy/DS002)
# trunk-ignore-all(trivy/DS026)

FROM ubuntu:22.04

LABEL maintainer="KyneSys Labs"
LABEL version="0.1"
LABEL description="The quickest way to run a DEMOS Network Node."

ARG DEBIAN_FRONTEND=noninteractive

# Install the necessary packages to run the node
RUN apt-get update && \
apt-get install -y \
curl git nodejs npm \
build-essential curl make gcc g++ \
--no-install-recommends
# Ensuring that we have node 20
RUN npm install -g n@latest
RUN n 20
# Ensure up-to-date node executable
RUN hash -r
# Install yarn
RUN npm install -g yarn@latest tsx@latest

# Go to the repository and install the necessary packages
#WORKDIR /
# REVIEW Clone the repository when will be public
# RUN git clone https://github.com/kynesyslabs/node
# TODO The copy below is thus temporary
RUN mkdir /node
COPY ./node /node
WORKDIR /node
RUN yarn

# Copying or creating the necessary files
COPY ./resources/peerlist /node/demos_peers

# Start the node
CMD ["yarn", "start"]

# Setting up ports
EXPOSE 53550