# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS node-deps

# better-sqlite3 may need a native build when a matching prebuild is unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    PATH=/opt/eduowl-venv/bin:$PATH \
    PYTHON_BIN=/opt/eduowl-venv/bin/python \
    EDUOWL_DB=/app/data/app.db \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 \
  && python3 -m venv /opt/eduowl-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY requirements-docker.txt ./
RUN /opt/eduowl-venv/bin/pip install --no-cache-dir -r requirements-docker.txt

COPY server ./server
COPY public ./public
COPY data ./data
COPY mcp.servers.json ./mcp.servers.json

RUN mkdir -p /app/data /app/data/logs /app/data/courses /app/data/trash \
  && chown -R node:node /app /opt/eduowl-venv

USER node

VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const t=process.env.EDUOWL_AUTH_TOKEN; fetch('http://127.0.0.1:8787/api/health',{headers:t?{Authorization:'Bearer '+t}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
