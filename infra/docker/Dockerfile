FROM node:24.18.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends -y chromium ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src ./src
COPY config ./config
COPY infra/docker/start-chrome.mjs /usr/local/bin/start-chrome.mjs
