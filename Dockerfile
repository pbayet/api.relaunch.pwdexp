# API de relance d'expiration des mots de passe AD.
# Build : docker compose build   |   Lancement : docker compose up -d
FROM node:22-alpine

# tzdata : la relance quotidienne part à PWD_REMINDER_HOUR en heure LOCALE du
# conteneur (UTC par défaut) — TZ est fixé dans docker-compose.yml.
RUN apk add --no-cache tzdata

WORKDIR /app

# Dépendances de production uniquement (couche mise en cache tant que
# package*.json ne change pas).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY src ./src
COPY app.js ./

# Utilisateur non-root ; logs/ lui appartient (volume nommé, cf. compose).
RUN mkdir -p /app/logs /app/certs && chown -R node:node /app/logs
USER node

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" > /dev/null || exit 1

CMD ["node", "app.js"]
