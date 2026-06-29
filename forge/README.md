# Laravel Forge deployment

Deploy tapo-power-alert on a [Laravel Forge](https://forge.laravel.com) server with Docker, WireGuard (gluetun), and Nginx as a TLS reverse proxy.

## Overview

```
Internet → Nginx (443/80) → 127.0.0.1:3000 → Docker (gluetun + app) → home LAN → Tapo plug
```

Forge opens ports 22, 80, and 443 by default ([network docs](https://forge.laravel.com/docs/resources/network)). The app port stays on localhost only — not exposed through UFW.

## One-time server setup

SSH in as `forge` (or use Forge → Server → Recipes).

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker tapo-power-alert   # use your actual site username
```

Log out and back in (or `newgrp docker`) so the `docker` group applies.

### 2. Docker access for the site user

Forge runs deploy scripts as the **site user** (e.g. `forge`, or an isolated user such as `tapo-power-alert`). Add that user to the `docker` group:

```bash
sudo usermod -aG docker tapo-power-alert   # use your actual site username
```

**Security note:** membership in the `docker` group is effectively root-equivalent on Linux — anyone in that group can control the host via the Docker socket. Only add the Forge deploy user, never expose the Docker TCP API (`2375`/`2376`) to the internet, and keep Forge’s SSH key-only access intact ([Forge security](https://forge.laravel.com/docs/servers/security)).

Do **not** run `sudo docker` in the deploy script unless you have a specific reason; group membership is enough.

### 3. Nginx template

1. Server → **Nginx Templates** → create a template ([docs](https://forge.laravel.com/docs/servers/nginx-templates)).
2. Paste the contents of [`nginx-template.conf`](nginx-template.conf).
3. Save (e.g. name it `Tapo Power Alert`).

Template edits do not update existing sites — pick the template when creating the site, or edit the site’s Nginx config manually later.

### 4. Create the site

1. **Sites** → create site → choose your domain.
2. **Project type:** Static HTML / Other (PHP is unused).
3. **Nginx template:** your Tapo Power Alert template.
4. Enable **zero-downtime deployments** if you want release-based deploys (recommended).
5. Connect your Git repository and branch.

### 5. Secrets (`.env` and `wg0.conf`)

`.env` is [automatically linked](https://forge.laravel.com/docs/sites/deployments#shared-paths) by Forge from the site root on each deploy. Set it via Forge → Site → Environment, or once on the server:

```bash
nano ~/your-site.com/.env
chmod 600 ~/your-site.com/.env
```

Required: `TAPO_EMAIL`, `TAPO_PASSWORD`, `TAPO_DEVICE_IP`, `NTFY_TOPIC`, `API_KEY`, `PORT=3000`.

Store `wg0.conf` at the **site root** next to `.env` (not in git). Do **not** symlink it into releases — Docker cannot bind-mount through symlinks reliably.

```bash
cp ~/your-site.com/current/wireguard/wg0.conf.example ~/your-site.com/wg0.conf
nano ~/your-site.com/wg0.conf
chmod 600 ~/your-site.com/wg0.conf
```

On deploy, `forge/deploy.sh` sets `WIREGUARD_CONFIG_PATH=$FORGE_SITE_ROOT/wg0.conf` so gluetun mounts the real file directly.

Example:

```
/home/tapo-power-alert/tapo-power-alert.arcanasoft.works/wg0.conf
```

### 6. SSL

Site → **SSL** → LetsEncrypt (or your certificate). Forge updates the `# FORGE SSL` placeholders in the generated Nginx config.

### 7. Optional: Nginx basic auth

For an extra layer in front of `API_KEY`, use Forge → Site → **Network** → **Security rules** ([docs](https://forge.laravel.com/docs/sites/network)). Forge does not store those passwords.

## Deploy script

Paste [`deploy.sh`](deploy.sh) into **Site → Deployments → Deploy Script**.

`$FORGE_SITE_PATH` is the `current` release directory ([deploy env vars](https://forge.laravel.com/docs/sites/deployments#environment-variables)).

Deployments time out after 10 minutes.

## Verify

```bash
cd ~/your-site.com/current
docker compose -f compose.server.yml ps
docker compose -f compose.server.yml logs -f tapo-power-alert
curl -s https://your-domain.com/health
curl -s -H "Authorization: Bearer $API_KEY" https://your-domain.com/status
```

## Firewall and Forge access

- Do not delete UFW port **22** — Forge needs SSH ([network docs](https://forge.laravel.com/docs/resources/network)).
- If you restrict SSH by IP, allow [Forge’s IP addresses](https://forge.laravel.com/docs/introduction#laravel-forge-ip-addresses).
- If you use deployment health checks, allow Forge’s [health check IPs](https://forge.laravel.com/docs/resources/network#health-check-service-ip-addresses) on 80/443.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `permission denied` on docker | `sudo usermod -aG docker <site-user>`, re-login |
| Missing wg0.conf on deploy | Create `$FORGE_SITE_ROOT/wg0.conf` on the server |
| `not a directory` mount error | Symlink or directory at `current/wireguard/wg0.conf` — use `WIREGUARD_CONFIG_PATH` instead |
| Nginx 502 | Containers down or `PORT` ≠ 3000; check `docker compose ps` |
| Tapo connection failed | WireGuard tunnel — see main README WireGuard section |
| API open without auth | Set `API_KEY` in `.env` and redeploy |

### `not a directory` mount error

Docker cannot bind-mount through **symlinks**. Remove any symlink from the release and mount the site-root file via `WIREGUARD_CONFIG_PATH`:

```bash
cd ~/tapo-power-alert.arcanasoft.works/current
docker compose -f compose.server.yml down
rm -f wireguard/wg0.conf   # remove symlink if present

export WIREGUARD_CONFIG_PATH=$HOME/tapo-power-alert.arcanasoft.works/wg0.conf
docker compose -f compose.server.yml up -d
```

Update the Forge deploy script to match `forge/deploy.sh` (no `ln -nfs`).
