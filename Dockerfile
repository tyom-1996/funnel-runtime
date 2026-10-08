# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/funnel.sqlite
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --workspace @funnel/server && npm cache clean --force
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY configs configs
VOLUME /data
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
