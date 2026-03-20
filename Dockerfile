FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY README.md ./

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
