FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/coin.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
