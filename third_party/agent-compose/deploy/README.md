# agent-compose deployment bundle

Installer and manual Docker Compose guidance for Linux **x86_64 (amd64)** and
**arm64**. The published daemon image is a full Linux image with Docker,
BoxLite, and Microsandbox compiled in. It defaults to the Docker driver, and
Docker selects the matching image architecture when pulling.

## Release assets

| Asset | Purpose |
|-------|---------|
| `agent-compose-installer.tar.gz` | Docker Compose installer bundle |
| `install.sh` | Standalone installer for `curl \| bash` |
| `SHASUMS256.txt` | Checksums |

GitHub Release does not contain standalone macOS or Linux daemon binaries.
Native binaries are local/CI verification artifacts; supported deployments use
the published multi-architecture images and these installer assets.

## Quick start

### One-line install

```bash
curl -fsSL https://github.com/chaitin/agent-compose/releases/latest/download/install.sh | bash
```

### From the installer archive

```bash
tar -xzf agent-compose-installer.tar.gz
cd agent-compose-installer
./install.sh
```

### Specific install directory

```bash
curl -fsSL https://github.com/chaitin/agent-compose/releases/latest/download/install.sh | \
  bash -s -- --dir /opt/agent-compose --port 8080
```

The installer starts the base daemon service. The frontend service is defined
under the `with-ui` profile; start it from the installation directory when you
want browser access:

```bash
cd <install-dir>
docker compose --profile with-ui up -d
```

On first run the installer generates the frontend admin password and prints it
once. Its summary includes the URL to use after the UI profile is enabled:

```
================ agent-compose is ready ================
  URL:        http://localhost:80
  Login credentials (generated, shown only once):
    Username: admin
    Password: <random>
========================================================
```

## Options

```
./install.sh --dir /opt/agent-compose --port 8080
./install.sh --version v1.2.3         # specific release (remote mode)
./install.sh --image-prefix registry.example.com/agent-compose   # mirror / private registry
./install.sh --upgrade                # update an existing install to the latest release
./install.sh --upgrade --version v1.2.3  # update to a specific release
./install.sh --no-start               # write files but don't pull images or start
./install.sh --yes                    # skip the confirmation prompt
```

## Requirements

- Docker Engine + Docker Compose v2
- Network access to the image registry (ghcr.io by default; use
  `--image-prefix` to pull from a mirror or private registry)
- `/dev/kvm` only if you enable the BoxLite or Microsandbox runtime drivers
  (the default `docker` driver does not need it)

The base `docker-compose.yml` mounts the Docker socket but has no privileged
mode or KVM device. `docker-compose.kvm.yml` is the explicit overlay that adds
those capabilities for BoxLite and Microsandbox.

## Compose selection

For a new installation, the installer checks whether `/dev/kvm` exists:

- when absent, it persists `COMPOSE_FILE=docker-compose.yml` and reports a
  Docker-only deployment topology;
- when present, it persists
  `COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml`.

The selected value is stored in `<install-dir>/.env`, so ordinary
`docker compose` management commands keep using the same file set. An existing
explicit `COMPOSE_FILE` is preserved across installer runs. This detection does
not verify KVM permissions, runtime artifacts, or driver health; validate the
host separately before selecting BoxLite or Microsandbox.

For a manual checkout-based deployment, create `.env`, then select the topology
explicitly:

```bash
# Docker-only base topology
docker compose -f docker-compose.yml up -d

# BoxLite/Microsandbox topology on a prepared Linux/KVM host
docker compose -f docker-compose.yml -f docker-compose.kvm.yml up -d
```

To make the second selection persistent for subsequent bare `docker compose`
commands, set this active assignment in `.env`:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml
```

## Manage

```bash
cd <install-dir>
docker compose ps
docker compose logs -f
docker compose --profile with-ui up -d   # start/update the web UI
docker compose down
```

Configuration lives in `<install-dir>/.env`; edit and re-run
`docker compose up -d` to apply changes. See `SECURITY.md` in the repository
before exposing the daemon beyond a trusted network.

Re-running the installer refreshes the Compose files and fills missing secrets
or image refs. `--upgrade` downloads the latest release bundle by default, even
when invoked from an older extracted bundle. Add `--version vX.Y.Z` to select a
specific release. Upgrade updates image refs only when they still match values
recorded as installer-managed; custom or otherwise user-managed refs in `.env`
remain unchanged.

The host data mount is persisted as `AGENT_COMPOSE_DATA_DIR` in the installed
`.env`. New installations use `./data`. When upgrading an installation whose
database exists only under the earlier `./data/agent-compose` layout, the
installer preserves that path instead of moving data. If databases exist in
both locations, the installer stops before changing files; set
`AGENT_COMPOSE_DATA_DIR=./data` or `./data/agent-compose` after identifying the
authoritative database, then retry the upgrade.

Before changing the installation directory, the installer prints a deployment
plan and asks for confirmation. Use `--yes` or `AGENT_COMPOSE_YES=1` for
non-interactive automation.

## Verification

Repository contributors can validate the installer, both Compose topologies,
and the exact release asset set without a running Docker daemon, KVM, network
access, or runtime sandboxes. The check invokes the Docker Compose parser and
also requires `jq`:

```bash
task test:deploy
```

After building the local daemon and guest images, verify the full image's
Docker path without privilege or KVM:

```bash
task image:agent-compose
task image:agent-compose-guest
task test:e2e:image-docker
```

Real BoxLite or Microsandbox verification is separate and requires a prepared
Linux/KVM host: `task test:runtime-smoke`.
