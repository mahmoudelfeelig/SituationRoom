# Hetzner deployment

SituationRoom is served as an immutable static image on the shared external Docker network `web`. The shared `/opt/caddy` proxy remains the only service that publishes host ports 80 and 443.

The production release root is `/opt/situationroom`. Each build is retained under `releases/<40-character-git-sha>`, while the stable Compose file selects the tested image through a server-only `.env` file. Only `dist/client` is served; the OpenAI Sites worker under `dist/server` is not part of the Hetzner runtime.

The private Caddy container implements the Sites fallback contract: hashed assets are immutable, missing assets and API paths remain errors, and only GET or HEAD requests accepting HTML can fall back to the application shell. The public Caddy route is in `Caddyfile.public`.

GitHub Actions is the normal release path. `SituationRoom CI` runs the complete component and browser gates, creates `dist/client/source/SituationRoom-source.tar.gz`, embeds `release.json`, validates both Caddy configurations, and smoke-tests the exact content-addressed image before publishing a checksummed artifact. `Deploy SituationRoom Production` accepts only that successful unsuperseded `main` SHA, loads the tested image, creates an immutable release directory, switches the stable Compose files, and runs internal plus public smoke checks. `deploy-release.sh` restores the previous Compose release if activation or any smoke check fails.

The production GitHub environment requires the `HETZNER_SSH_PRIVATE_KEY` secret and `HETZNER_HOST`, `HETZNER_SSH_PORT`, `HETZNER_USER`, `HETZNER_SSH_KNOWN_HOSTS`, and `SITUATIONROOM_EXTERNAL_SMOKE_URL` variables. SSH host verification remains strict. Routine releases do not restart the shared proxy or change Cloudflare DNS.

The Cloudflare record is a proxied `A` record named `situationroom` pointing to the Hetzner origin. Keep HTML on revalidation, cache only hashed `/assets/*` paths long-term, disable Rocket Loader for this hostname, and use Full (strict) TLS.
