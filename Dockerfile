# Base settings
FROM ubuntu:20.04
WORKDIR /root
# Preparing the directories that will be shared with the host
RUN mkdir evm
RUN mkdir demos
RUN mkdir common
# Installing basic packages
ARG DEBIAN_FRONTEND=noninteractive
RUN apt update -y
RUN apt install -y net-tools build-essential nodejs npm python3 vim wget curl screen
RUN npm install -g n
RUN n 16.18.1
RUN hash -r
# Copying over the required files
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
