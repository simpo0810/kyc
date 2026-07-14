FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# better-sqlite3 compiles a native addon; alpine needs build tools for that
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package*.json server.js ./
COPY src ./src

# SQLite lives here; mount a volume at /data so it survives redeploys
ENV DB_PATH=/data/data.db
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
