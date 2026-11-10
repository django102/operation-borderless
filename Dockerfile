# syntax=docker/dockerfile:1

# ---- build: compile TypeScript with the full dependency tree --------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled output only --------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The OpenAPI document is served at /docs and /openapi.json.
COPY docs ./docs
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1
CMD ["node", "dist/server.js"]
