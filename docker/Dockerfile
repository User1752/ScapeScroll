# Node 24 is the LTS line the exe, CI and development use; Node 20 stopped receiving fixes in 2026.
FROM node:24-alpine

# A source that asks its site through curl (MangaHub does) needs the program itself: node:alpine does not ship it, and System Health
# said "curl was not found on this computer".
RUN apk add --no-cache curl

WORKDIR /app

# Instalar dependências
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-package-lock

# Copiar o resto do projeto (incluindo data/sources)
COPY . .

# Ensure all required data directories exist (volume is mounted at runtime)
RUN mkdir -p /app/data/sources /app/data/cache /app/data/local /app/data/tmp

ENV PORT=3000
# A container on a home network usually has no IPv6 route, and a site that publishes an IPv6 address then made some requests time out
# ("fetch failed", ETIMEDOUT; measured on a CasaOS box: 4 of 5 sites fine, 2 of 5 calls to one failing, none after this setting).
# IPv4 first costs nothing where IPv6 does work.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Inside a container the app has to listen on every interface so the published
# port reaches it; keeping the *host* side private is the compose file's
# `ports:` mapping (127.0.0.1:...), not this.
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
