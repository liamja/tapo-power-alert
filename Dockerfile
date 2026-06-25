FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json server.js ./

EXPOSE 3000

CMD ["bun", "run", "start"]
