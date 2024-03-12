# trunk-ignore-all(trivy/DS002)
# trunk-ignore-all(trivy/DS026)

FROM ubuntu:22.04

LABEL maintainer="KyneSys Labs"
LABEL version="0.1"
LABEL description="The quickest way to run a DEMOS Network Node."

ARG DEBIAN_FRONTEND=noninteractive

# TODO Will be removed in the future
COPY ./node /node

# Install the necessary packages to run the node
RUN apt update && apt install -y curl git nodejs npm
# Ensuring that we have node 20
RUN npm install -g n
RUN n 20
# Ensure up-to-date node executable
RUN hash -r
# Install yarn
RUN npm install -g yarn

# REVIEW Clone the repository when will be public
# RUN git clone

# Go to the repository and install the necessary packages
WORKDIR /node
RUN yarn

# Start the node
CMD ["yarn", "start"]

# Setting up ports
EXPOSE 53550