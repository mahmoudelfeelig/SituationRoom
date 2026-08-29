# Production release contract

This public repository contains only reviewable application release inputs: artifact identifiers, the public hostname, and the app-local container contract used by CI. It contains no server address, login identity, deployment key, host filesystem layout, credentials, privileged origin-access procedure, or private controller topology.

GitHub Actions is the normal release path. `SituationRoom CI` runs the complete component and browser gates, creates the corresponding-source archive, embeds public `release.json` metadata, smoke-tests the exact content-addressed image, and publishes a checksummed short-lived artifact.

After that trusted `main` run succeeds, `.github/workflows/deploy-production.yml` acts only as a thin caller. It invokes the public reusable [Hetzner Release Gateway](https://github.com/mahmoudelfeelig/HetznerReleaseGateway) at an immutable reviewed commit and passes the application identifier, source commit, and successful CI run identity. The reusable workflow and private deployment controller independently revalidate provenance before any activation. Host credentials, topology, rollback implementation, and signed deployment receipts remain private and centralized.

The public application contract is independent of the private hosting layout:

- `https://situationroom.elfeel.me/` serves the application over valid HTTPS.
- HTML routes, including copied deep links, return the application shell only for safe browser navigations.
- Existing fingerprinted assets return the expected MIME type and immutable cache policy.
- Missing assets, unsupported API paths, and unsupported methods remain errors and are not rewritten to HTML.
- `https://situationroom.elfeel.me/release.json` exposes public release metadata suitable for matching a deployment to repository history without exposing infrastructure.
- `https://situationroom.elfeel.me/source/SituationRoom-source.tar.gz` provides the corresponding source archive with download disposition.

Public verification may use ordinary HTTPS requests plus installed Chrome and Edge. It must not connect directly to an origin, override DNS, bypass the public TLS endpoint, inspect private services, or depend on host access. A release is accepted only after the public HTTP contract, browser UI, and browser WebMCP checks pass; failure leaves the previously accepted release authoritative.
