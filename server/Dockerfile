FROM node:20 AS base
WORKDIR /app
COPY package*.json ./

FROM base AS deps-dev
RUN npm ci

FROM base AS deps-prod
RUN npm ci --omit=dev

# FROM deps-dev AS builder

# COPY . .

# RUN npm run build

FROM deps-dev AS dev

COPY . .

CMD ["npm", "run", "dev"]

FROM deps-prod AS prod

COPY . .

CMD ["npm", "run", "start"]