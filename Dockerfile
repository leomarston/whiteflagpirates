# Multi-stage build for Railway (and any Docker host).
# Stage 1 installs ALL deps (incl. devDependencies like vite) and builds dist/.
# Stage 2 is a tiny runtime image that just serves the static build — zero deps.

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# install with dev deps so `vite` is present, regardless of NODE_ENV
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# only the static build + the zero-dependency server are needed at runtime
COPY --from=build /app/dist ./dist
COPY server.js package.json ./

EXPOSE 8080
CMD ["node", "server.js"]
