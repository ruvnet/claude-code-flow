FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV PORT=8080
# The signing key is NOT baked in. Cloud Run mounts it read-only at
# /secrets/nostr/signing-key from Secret Manager; there is no build arg,
# no env var and no image layer that carries it.
EXPOSE 8080
CMD ["node", "src/server.mjs"]
