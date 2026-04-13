FROM node:20

WORKDIR /app

# RUN apt-get update \
#   && apt-get install -y --no-install-recommends curl \
#   && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/server.js"]