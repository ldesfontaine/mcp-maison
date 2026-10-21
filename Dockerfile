# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 est un module natif : npm ci télécharge son binaire précompilé (musl) s'il en existe un pour
# cette version de Node, sinon le compile. D'où python3, make et g++, présents dans cette étape seulement.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json permissions.example.yaml ./
# /app/data : base SQLite et journal, à monter en volume (écrit par l'utilisateur node, uid 1000).
# /app/config : permissions.yaml, à monter en DOSSIER (lecture seule) avec
# PERMISSIONS_FILE=/app/config/permissions.yaml, pour que les modifications soient vues à chaud. Sans fichier : droits minimaux (ping, whoami) pour tous.
RUN mkdir -p /app/data /app/config && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/main.js"]
