FROM node:16-alpine
WORKDIR /usr/src/app

# Preparing the directories that will be shared with the host
RUN mkdir evm
RUN mkdir demos
RUN mkdir common


# Installing basic packages
RUN apk update
RUN apk add --no-cache vim wget screen curl bash nodejs npm yarn make g++ py3-pip
RUN hash -r
RUN npm install -g eslint
# RUN n 16

COPY demos/package.json demos/yarn.lock ./demos/
RUN yarn --cwd ./demos install
COPY . .


COPY requirements/geth /usr/local/bin/
RUN chmod +x /usr/local/bin/geth
# Notifying about port exposure
EXPOSE 53550
EXPOSE 8545
EXPOSE 8546
EXPOSE 80
EXPOSE 443
EXPOSE 30303
EXPOSE 53000
# Persistence through bash session
CMD ["/bin/bash"]
