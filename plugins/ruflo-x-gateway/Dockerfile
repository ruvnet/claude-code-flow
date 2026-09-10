FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV PORT=8080
# persistent Nostr identity; mount a volume at /data in prod, ephemeral otherwise
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "src/server.mjs"]
