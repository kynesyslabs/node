FROM node:18-alpine

RUN set -x \
    && apk update \
    && apk upgrade \
    && apk add --no-cache \
    udev

WORKDIR /usr/src/app

COPY package.json yarn.lock ./

RUN yarn install

COPY . .

RUN yarn build

CMD [ "yarn", "start:prod" ]