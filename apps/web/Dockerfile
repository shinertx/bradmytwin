FROM node:20-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm install

COPY . .
RUN npm run build -w @brad/web

CMD ["node", "apps/web/dist/server.js"]
