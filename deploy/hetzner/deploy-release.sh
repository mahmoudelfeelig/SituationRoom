#!/bin/sh
set -eu

RELEASE_SHA=${1:-}
INCOMING_DIR=${2:-}
EXTERNAL_SMOKE_URL=${3:-}
DEPLOY_ROOT=${SITUATIONROOM_DEPLOY_ROOT:-/opt/situationroom}

if test "$DEPLOY_ROOT" != "/opt/situationroom"; then
  echo "SituationRoom deploy root must be /opt/situationroom." >&2
  exit 64
fi
if test "${#RELEASE_SHA}" -ne 40; then
  echo "Release SHA must contain exactly 40 lowercase hexadecimal characters." >&2
  exit 64
fi
case "$RELEASE_SHA" in
  *[!0-9a-f]*) echo "Release SHA must be lowercase hexadecimal." >&2; exit 64 ;;
esac
if test "$INCOMING_DIR" != "/tmp/situationroom-release-$RELEASE_SHA"; then
  echo "Incoming directory does not match the release SHA." >&2
  exit 64
fi
if test "$EXTERNAL_SMOKE_URL" != "https://situationroom.elfeel.me"; then
  echo "External smoke URL is not the approved SituationRoom origin." >&2
  exit 64
fi

IMAGE="situationroom-web:$RELEASE_SHA"
RELEASE_DIR="$DEPLOY_ROOT/releases/$RELEASE_SHA"
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.yml"
ENV_FILE="$DEPLOY_ROOT/.env"
BACKUP_COMPOSE="$DEPLOY_ROOT/docker-compose.yml.before-$RELEASE_SHA"
BACKUP_ENV="$DEPLOY_ROOT/.env.before-$RELEASE_SHA"
NEXT_COMPOSE="$DEPLOY_ROOT/docker-compose.yml.next-$RELEASE_SHA"
NEXT_ENV="$DEPLOY_ROOT/.env.next-$RELEASE_SHA"
STATE_FILE="$DEPLOY_ROOT/.last-successful-sha"
PREVIOUS_FILE="$DEPLOY_ROOT/.previous-successful-sha"
STAGING_DIR=""
PRODUCTION_CHANGED=false

cleanup() {
  if test -n "$STAGING_DIR" && test -d "$STAGING_DIR"; then
    case "$STAGING_DIR" in
      "$DEPLOY_ROOT"/releases/.staging-"$RELEASE_SHA".*) rm -rf -- "$STAGING_DIR" ;;
      *) echo "Refusing to clean an unexpected staging path." >&2 ;;
    esac
  fi
  rm -f -- \
    "$INCOMING_DIR/SHA256SUMS" \
    "$INCOMING_DIR/deploy-release.sh" \
    "$INCOMING_DIR/situationroom-files.tar.gz" \
    "$INCOMING_DIR/situationroom-image.tar.gz"
  rmdir -- "$INCOMING_DIR" 2>/dev/null || true
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$PRODUCTION_CHANGED" = true; then
    echo "SituationRoom deployment failed; restoring the previous Compose release." >&2
    if test -f "$BACKUP_ENV" && test -f "$BACKUP_COMPOSE"; then
      cp -p "$BACKUP_ENV" "$ENV_FILE"
      cp -p "$BACKUP_COMPOSE" "$COMPOSE_FILE"
      if ! compose up -d --no-build --wait --wait-timeout 120; then
        echo "Previous SituationRoom release restoration failed." >&2
      fi
    else
      echo "No complete previous release metadata was available for rollback." >&2
      compose stop situationroom-web >/dev/null 2>&1 || true
    fi
  fi
  cleanup
  exit "$status"
}

trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test -d "$INCOMING_DIR"
test -f "$INCOMING_DIR/SHA256SUMS"
test -f "$INCOMING_DIR/situationroom-image.tar.gz"
test -f "$INCOMING_DIR/situationroom-files.tar.gz"
cd "$INCOMING_DIR"
sha256sum --check SHA256SUMS

docker network inspect web >/dev/null
gzip -dc situationroom-image.tar.gz | docker load
docker image inspect "$IMAGE" >/dev/null
docker run --rm --entrypoint caddy "$IMAGE" \
  validate --config /etc/caddy/Caddyfile

install -d -m 755 "$DEPLOY_ROOT/releases"
if test -d "$RELEASE_DIR"; then
  test -f "$RELEASE_DIR/dist/client/release.json"
  grep -Fq "\"sha\":\"$RELEASE_SHA\"" "$RELEASE_DIR/dist/client/release.json"
  test -f "$RELEASE_DIR/deploy/hetzner/docker-compose.yml"
else
  STAGING_DIR=$(mktemp -d "$DEPLOY_ROOT/releases/.staging-$RELEASE_SHA.XXXXXX")
  tar -xzf situationroom-files.tar.gz -C "$STAGING_DIR" --no-same-owner
  test -f "$STAGING_DIR/dist/client/index.html"
  test -f "$STAGING_DIR/dist/client/source/SituationRoom-source.tar.gz"
  test -f "$STAGING_DIR/deploy/hetzner/docker-compose.yml"
  grep -Fq "\"sha\":\"$RELEASE_SHA\"" "$STAGING_DIR/dist/client/release.json"
  mv "$STAGING_DIR" "$RELEASE_DIR"
  STAGING_DIR=""
fi

if test -f "$ENV_FILE"; then
  cp -p "$ENV_FILE" "$BACKUP_ENV"
fi
if test -f "$COMPOSE_FILE"; then
  cp -p "$COMPOSE_FILE" "$BACKUP_COMPOSE"
fi
cp -p "$RELEASE_DIR/deploy/hetzner/docker-compose.yml" "$NEXT_COMPOSE"
{
  printf 'SITUATIONROOM_IMAGE_TAG=%s\n' "$RELEASE_SHA"
  printf 'SITUATIONROOM_RELEASE_DIR=%s\n' "$RELEASE_DIR"
} > "$NEXT_ENV"
docker compose --env-file "$NEXT_ENV" -f "$NEXT_COMPOSE" config --quiet
PRODUCTION_CHANGED=true
mv "$NEXT_COMPOSE" "$COMPOSE_FILE"
mv "$NEXT_ENV" "$ENV_FILE"

compose up -d --no-build --wait --wait-timeout 120
test "$(docker inspect --format '{{.State.Health.Status}}' situationroom-web)" = healthy
docker exec situationroom-web \
  wget --quiet --output-document=- http://127.0.0.1:8080/ \
  | grep -Fq "SituationRoom"
docker exec situationroom-web \
  wget --quiet --output-document=- \
    --header='Accept: text/html' \
    http://127.0.0.1:8080/cases/procurement-demo/analyze/investigate \
  | grep -Fq "SituationRoom"
docker exec situationroom-web \
  wget --quiet --output-document=- http://127.0.0.1:8080/release.json \
  | grep -Fq "\"sha\":\"$RELEASE_SHA\""

curl --fail --silent --show-error \
  --retry 5 --retry-delay 2 --retry-all-errors --max-time 20 \
  "$EXTERNAL_SMOKE_URL/release.json?sha=$RELEASE_SHA" \
  | grep -Fq "\"sha\":\"$RELEASE_SHA\""
curl --fail --silent --show-error \
  --retry 3 --retry-delay 2 --retry-all-errors --max-time 20 \
  --header 'Accept: text/html' \
  "$EXTERNAL_SMOKE_URL/cases/procurement-demo/analyze/investigate" \
  | grep -Fq "SituationRoom"
missing_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 20 "$EXTERNAL_SMOKE_URL/assets/missing-$RELEASE_SHA.js")
test "$missing_status" = 404

previous_sha=""
if test -f "$STATE_FILE"; then
  previous_sha=$(sed -n '1p' "$STATE_FILE")
fi
if test -n "$previous_sha" && test "$previous_sha" != "$RELEASE_SHA"; then
  printf '%s\n' "$previous_sha" > "$PREVIOUS_FILE"
fi
printf '%s\n' "$RELEASE_SHA" > "$STATE_FILE"

PRODUCTION_CHANGED=false
trap - EXIT HUP INT TERM
cleanup
echo "SituationRoom deployment $RELEASE_SHA passed internal and public smoke checks."
