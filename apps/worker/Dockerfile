FROM node:20-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/clients/package.json packages/clients/package.json
RUN npm install

COPY . .
RUN npm run build -w @brad/domain && npm run build -w @brad/clients && npm run build -w @brad/worker

CMD ["node", "apps/worker/dist/index.js"]
