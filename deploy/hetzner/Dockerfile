FROM caddy:2.9-alpine

RUN setcap -r /usr/bin/caddy \
  && addgroup -S -g 10001 situationroom \
  && adduser -S -D -H -u 10001 -G situationroom situationroom

COPY deploy/hetzner/Caddyfile /etc/caddy/Caddyfile
COPY dist/client/ /srv/

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/index.html || exit 1
