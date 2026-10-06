# Hosted oec.sh MCP server (streamable HTTP, stateless).
# Build: docker build -t oecsh-mcp ./mcp-server
# Run:   docker run -p 127.0.0.1:8080:8080 -e OECSH_MCP_ALLOWED_HOSTS=mcp.oec.sh oecsh-mcp
#        (OECSH_MCP_ALLOWED_HOSTS=localhost to try it on your machine)
# Publish the port on loopback (or not at all, on the proxy's Docker network):
# the origin must be reachable only through Cloudflare and Traefik.
#
# Base image pinned by digest (node:22-slim, multi-arch index). To update:
#   docker buildx imagetools inspect node:22-slim
# and replace the digest in both stages.

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Inside a container the server must listen on all interfaces; the Host and
# Origin checks for loopback binds do not apply here, so put it behind a
# proxy (Traefik) and set OECSH_MCP_ALLOWED_HOSTS to the public host name.
# The server refuses to start on this bind without it (or without
# OECSH_MCP_ALLOW_ANY_HOST=1). To reach the API over the internal network by
# plain http (an internal address such as http://api:8000/...), also set
# OECSH_API_ALLOW_HTTP=1.
# So that the API blocks a caller who sends bad keys and not this server's one
# address for everyone, set OECSH_MCP_PROXY_SECRET (32+ printable ASCII
# characters, no spaces, e.g. openssl rand -hex 32; pass it at run time, never
# bake it into the image). Set the identical value as PLATFORM_MCP_PROXY_SECRET
# on the API first: with a missing or different value the API ignores the
# headers, and this server cannot tell. Only for an API you configure; leave it
# unset against api.oec.sh. Each API request then carries the caller's address,
# read from the header named by OECSH_MCP_CLIENT_IP_HEADER (default
# cf-connecting-ip, which Cloudflare sets in front of Traefik) only when the
# hop in front of Traefik (the last X-Forwarded-For entry) is Cloudflare's edge
# or listed in OECSH_MCP_TRUSTED_PROXIES (comma-separated addresses or CIDR
# ranges); otherwise that hop is the caller's address.
ENV OECSH_MCP_HOST=0.0.0.0 \
    OECSH_MCP_PORT=8080 \
    OECSH_API_URL=https://api.oec.sh/api/public/v1

# The image's unprivileged "node" user, by number so the runtime need not resolve the name.
USER 1000:1000
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OECSH_MCP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/http.js"]
