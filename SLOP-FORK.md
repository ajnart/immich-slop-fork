# Slop fork: RAW companions

This experiment starts at Immich **v3.3.6**, commit `587f549f46f1cd1822a06e16dcccecef04ea4565`, on `slop-fork/raw-companions` in `ajnart/immich-slop-fork`. Existing `main` and upstream branches are not changed. Enable the experiment with `IMMICH_RAW_COMPANIONS=true` on the server.

Use this as a **same-version server swap**. If your installation is older or newer than v3.3.6, first follow Immich's supported upgrade/restore process separately. An upgrade from another version may run database migrations. This branch adds no schema migrations; CI verifies that the schema and migration paths still match the baseline. Keep machine learning, database, Redis, clients, volumes, and your existing configuration compatible with v3.3.6.

## Quick start

1. Confirm an existing **v3.3.6, Linux amd64** installation and complete the [checkpoint](#checkpoint-before-the-trial), including the original image, database, and media backup.
2. Copy the immutable image digest from a successful fork CI run into the [trial commands](#try-the-tested-image). The override swaps only the server image and enables `IMMICH_RAW_COMPANIONS=true`.
3. Upload a small matching RAW/JPEG pair in both orders, inspect the stack and original downloads, then keep testing or run the [rollback commands](#roll-back-to-the-exact-original-image).

Matching is deliberately conservative: exactly one RAW and one JPEG (`.jpg`/`.jpeg`) or PNG image must share the filename stem, owner, and library. Uploaded pairs need matching EXIF capture time, camera make, and model; external-library pairs must share a directory and must not have conflicting metadata. Archive visibility and favorite status must also agree, preserving those user choices. Ambiguous matches, edited assets, offline or trashed assets, Live Photos, and incompatible existing stacks are skipped. The rendered image becomes the stack primary, while both originals remain independent assets.

The RAW asset still owns separate generated thumbnail and preview files, sourced from its rendered companion when pairing succeeds. This avoids expensive RAW decoding for paired thumbnail jobs; it does **not** remove all RAW derivative storage or merge original files. Existing library pairs need thumbnail reprocessing to be considered; start with a small sample.

## Build and evidence

The unchanged baseline is recorded locally as `slop-checkpoint/v3.3.6`. Its existing media and stack suites passed 218 tests before implementation. The completed experiment passed all 107 server unit-test files locally: 2,403 tests passed and one upstream test remained an expected failure. Database and real-import results must come from the successful CI run linked below; local unit tests alone do not prove those flows work.

The dedicated [Slop fork image workflow](.github/workflows/slop-fork.yml) runs only on this fork and feature branch, after a push or manual dispatch. It uses standard GitHub `ubuntu-24.04` runners, `contents: read`, and `packages: write` for the publishing job. It needs no upstream app credentials or Docker Hub secrets. A push consumes GitHub Actions resources and, on success, publishes a new GHCR package version. It does not deploy anything to your server.

The workflow runs all server unit and database medium tests, builds and checks the server, then builds the complete upstream server Dockerfile, including web UI, CLI, and plugins. It starts the resulting image with disposable PostgreSQL and Valkey containers and checks the API, version, web UI, actual RAW/JPEG uploads in both orders, and original download checksums. It then restarts the same image with the feature disabled, checks existing assets, and verifies fresh pairs stay unstacked before publishing that image. Runtime logs are retained for seven days. The workflow summary is the source of the tested image tag and immutable digest; a prepared workflow is not evidence that a build has passed.

Images are `linux/amd64` only. The package is `ghcr.io/ajnart/immich-slop-fork`, with a unique tag containing `v3.3.6`, the complete source commit, run ID, and attempt. There is no moving `latest` tag. Use the digest from a **successful** run when deploying. GHCR package visibility may initially be private; authenticate Docker with an account allowed to read the package if needed.

## Checkpoint before the trial

Run these commands in the existing Docker Compose installation directory, using Bash. They assume the standard service names and `docker-compose.yml`; retain your existing additional Compose files if your deployment uses them. Confirm the running server is already v3.3.6:

```bash
set -euo pipefail
curl --fail --silent --show-error http://127.0.0.1:2283/api/server/version | jq -e '.major == 3 and .minor == 3 and .patch == 6'
umask 077
mkdir slop-backup
cp docker-compose.yml slop-backup/docker-compose.yml
cp .env slop-backup/env
server_id=$(docker compose ps -q immich-server)
test -n "$server_id"
original_image=$(docker inspect "$server_id" --format '{{.Image}}')
docker image tag "$original_image" immich-slop-rollback:v3.3.6
printf '%s\n' "$original_image" > slop-backup/server-image-id.txt
docker compose stop immich-server
docker compose exec -T database sh -c 'pg_dump --clean --if-exists --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' | gzip > slop-backup/database.sql.gz
test -s slop-backup/database.sql.gz
```

While the server is stopped, take a matching backup or filesystem snapshot of the upload/media storage and preserve any external library files. Record its location alongside `slop-backup`. A database dump alone is not a complete Immich backup. Keep the original Docker image locally and do not prune it during the trial. If backup or preparation fails, restart the original server with `docker compose start immich-server` before troubleshooting.

## Try the tested image

Set `SLOP_IMAGE` to the exact `ghcr.io/ajnart/immich-slop-fork@sha256:...` digest from the successful workflow summary, then run:

```bash
export SLOP_IMAGE='ghcr.io/ajnart/immich-slop-fork@sha256:REPLACE_WITH_SUCCESSFUL_RUN_DIGEST'
docker pull "$SLOP_IMAGE"
cat > slop-fork.yml <<EOF_COMPOSE
services:
  immich-server:
    image: ${SLOP_IMAGE}
    environment:
      IMMICH_RAW_COMPANIONS: 'true'
EOF_COMPOSE
docker compose -f docker-compose.yml -f slop-fork.yml up -d --no-deps immich-server
docker compose -f docker-compose.yml -f slop-fork.yml logs --tail=100 immich-server
curl --fail --silent --show-error http://127.0.0.1:2283/api/server/ping
```

Use the override on subsequent Compose operations while testing. Start with a small disposable set of matching RAW/JPEG photos, upload in both orders, and check stack membership, the visible JPEG primary, and original downloads. Preserve the source files for comparison. Do not bulk reprocess the real library until that sample behaves as expected.

## Roll back to the exact original image

This uses the local image captured before the trial, without pulling a mutable upstream tag:

```bash
cat > slop-rollback.yml <<'EOF_COMPOSE'
services:
  immich-server:
    image: immich-slop-rollback:v3.3.6
    environment:
      IMMICH_RAW_COMPANIONS: 'false'
EOF_COMPOSE
docker compose -f docker-compose.yml -f slop-rollback.yml up -d --no-deps --pull never immich-server
docker compose -f docker-compose.yml -f slop-rollback.yml logs --tail=100 immich-server
curl --fail --silent --show-error http://127.0.0.1:2283/api/server/ping
```

An image rollback does not undo application data changes made during the trial, including created stacks or generated thumbnails. You can unstack trial pairs in Immich. To restore the entire pre-trial state, restore the matching database and media backup together using Immich's restore procedure. Do not delete volumes or overwrite database files as part of an ordinary image rollback.
