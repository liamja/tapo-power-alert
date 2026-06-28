# Tapo Power Alert

A small Bun server that watches a Tapo P110 smart plug and sends a push notification when your dryer finishes.

## Quick start

Get push notifications on your phone when the dryer finishes. Takes about 10 minutes.

### What you need

- A **Tapo P110** smart plug on the dryer's power
- A computer on the same home network (Mac, Linux, Raspberry Pi, etc.)
- **[Bun](https://bun.sh)** installed
- The **[ntfy](https://ntfy.sh)** app on each phone (free)

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Configure

```bash
git clone <your-repo-url>
cd tapo-power-alert
cp .env.example .env
nano .env   # or use any text editor
```

Fill in these values:

```bash
# Your Tapo account (same as the Tapo app)
TAPO_EMAIL=you@example.com
TAPO_PASSWORD=your_tapo_password
TAPO_DEVICE_IP=192.168.1.100    # P110 IP — find it in your router

# Pick a random topic name (both phones will subscribe to this)
NTFY_TOPIC=dryer-finished-xK9m2pQ
```

Everything else has sensible defaults. Email via Postmark is optional — see [Configuration](#configuration) if you want it as a backup.

**Find the P110 IP:** open your router's admin page → connected devices → look for the Tapo plug.

### 3. Set up phones

On **each phone**:

1. Install **ntfy** ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. Tap **+** → **Subscribe to topic**
3. Enter your `NTFY_TOPIC` name (e.g. `dryer-finished-xK9m2pQ`)
4. Tap **Subscribe**

Both phones are done. One alert reaches everyone subscribed to the topic.

### 4. Run

```bash
bun run dev      # development (auto-reload)
bun run start    # production
```

You should see something like:

```
✅ Credentials validated successfully!
📊 Device is online and responding
⚡ Current power: 12.3W
📱 Push notifications enabled: https://ntfy.sh/dryer-finished-xK9m2pQ
📧 Email notifications disabled (missing EMAIL_TO or POSTMARK_API_TOKEN)

🚀 Tapo Power Alert running on http://localhost:3000
   Status: ✅ Ready to monitor
📊 Heating threshold: 1500W
📊 Off threshold: 50W
🔁 Cooldown readings: 3 (every 60s)
```

If credential validation fails, double-check `TAPO_DEVICE_IP` and your Tapo login — the server still starts but monitoring will fail until credentials are fixed.

### 5. Verify

```bash
curl http://localhost:3000/status    # current power draw
curl http://localhost:3000/state     # monitoring state
```

Run a dryer cycle and watch the logs. When it finishes you should get a push on both phones within a few minutes.

## Features

- Monitors Tapo P110 power draw over your local network (no cloud polling)
- Push notifications via [ntfy](https://ntfy.sh) — works on multiple phones from one topic
- Optional email backup via Postmark
- Detects real "finished" state, not just the cooling phase
- Validates Tapo credentials on startup
- Logs API endpoint access (timestamp, path, auth result, client IP)
- Lightweight single-file app (`server.js`)

## Configuration

Copy `.env.example` to `.env` and fill in:

### Required — Tapo

```bash
TAPO_EMAIL=your_tapo_email@example.com
TAPO_PASSWORD=your_tapo_password
TAPO_DEVICE_IP=192.168.1.100       # find in your router's device list
```

### Required — Push notifications

```bash
NTFY_TOPIC=dryer-finished-xK9m2pQ  # pick a random, hard-to-guess name
NTFY_SERVER=https://ntfy.sh        # default; self-host if you prefer
```

Subscribe to `NTFY_TOPIC` in the ntfy app on every phone that should get alerts.

### Optional — Email backup

```bash
EMAIL_FROM=noreply@yourdomain.com
EMAIL_TO=you@example.com,wife@example.com   # comma-separated
POSTMARK_API_TOKEN=your_postmark_api_token
```

### Optional — Detection tuning

```bash
HEATING_THRESHOLD=1500    # must see this before a cycle counts (W)
OFF_THRESHOLD=50          # power below this = dryer is off (W)
RUNNING_THRESHOLD=800     # used for status reporting (W)
COOLDOWN_READINGS=3       # consecutive off readings before alert
CHECK_INTERVAL=60         # seconds between checks
PORT=3000                 # set to 0 or empty to disable HTTP API (monitoring still runs)
```

### Optional — API security

```bash
API_KEY=your-secret-key
```

When set, `/check`, `/status`, `/state`, and `/reset` require `Authorization: Bearer your-secret-key` or `?key=your-secret-key`. Each request is logged to stdout.

## How it works

```
Heating (>1500W)  →  Cooling (100–300W)  →  Off (<50W)  →  Alert
     ↑                      ↑                    ↑
  cycle starts          still running      3 checks in a row
```

1. Poll the P110 every `CHECK_INTERVAL` seconds (default: 60s)
2. Wait until power exceeds `HEATING_THRESHOLD` — confirms a real dry cycle
3. Ignore the cooling phase (typically 100–300W, still above `OFF_THRESHOLD`)
4. When power stays below `OFF_THRESHOLD` for `COOLDOWN_READINGS` consecutive checks, send notification
5. Reset when the next heating cycle starts

**Default timing:** 3 checks × 60 seconds = ~3 minutes after the dryer actually stops.

**Typical dryer power levels:**

| Phase | Power |
|-------|-------|
| Off | 0–10W |
| Cooling tumble | 100–300W |
| Heating | 2000–5000W |

## API endpoints

Set `PORT=0` or `PORT=` in `.env` to run monitoring only with no HTTP server. Useful when you do not need `curl` access and do not want the API reachable on your network.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /` | — | Simple health check |
| `GET /health` | — | Health check with timestamp |
| `GET /status` | API key | Current power draw from P110 |
| `GET /state` | API key | In-memory monitoring state |
| `GET /check` | API key | Run one detection cycle now |
| `GET /reset` | API key | Reset monitoring state (for testing) |

Auth is only enforced when `API_KEY` is set. Without it, all endpoints are open on localhost.

```bash
curl http://localhost:3000/status
curl -H "Authorization: Bearer your-secret-key" http://localhost:3000/state
curl "http://localhost:3000/status?key=your-secret-key"
```

## Tuning

Watch your dryer's actual power during a full cycle:

```bash
curl http://localhost:3000/status
```

| Symptom | Try |
|---------|-----|
| Alert while dryer still tumbling | Raise `OFF_THRESHOLD` (e.g. 80) or `COOLDOWN_READINGS` |
| Alert never fires | Lower `HEATING_THRESHOLD`; check logs for power readings |
| Alert too slow | Lower `CHECK_INTERVAL` or `COOLDOWN_READINGS` |
| Alert too fast | Raise `COOLDOWN_READINGS` |

Alert delay = `CHECK_INTERVAL` × `COOLDOWN_READINGS` (default: 180 seconds).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Credential validation failed | Confirm `TAPO_DEVICE_IP` in router; use same email/password as Tapo app; ping the device |
| Connection failed | Check `TAPO_DEVICE_IP`; server and plug must be on the same network |
| No push notification | Confirm both phones subscribed to the exact `NTFY_TOPIC`; check logs for `📱 Push notification sent via ntfy`; test with `curl -d "test" https://ntfy.sh/your-topic-name` |
| No email | Verify Postmark token and that `EMAIL_FROM` is verified in Postmark; check spam folder |
| Alert too early | Increase `COOLDOWN_READINGS` or `OFF_THRESHOLD` in `.env` |
| Alert too late | Decrease `COOLDOWN_READINGS` or `CHECK_INTERVAL` in `.env` |
| Missed alert after restart | State is in-memory only — server lost state mid-cycle; it'll catch the next one |

## Run as a service

### systemd

Create `/etc/systemd/system/tapo-power-alert.service`:

```ini
[Unit]
Description=Tapo Power Alert
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/tapo-power-alert
Environment="PATH=/path/to/bun/bin"
EnvironmentFile=/path/to/tapo-power-alert/.env
ExecStart=/path/to/bun/bin/bun run server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable tapo-power-alert
sudo systemctl start tapo-power-alert
sudo journalctl -u tapo-power-alert -f    # view logs
```

### Docker

```bash
docker build -t tapo-power-alert .
docker run -d --env-file .env -p 3000:3000 tapo-power-alert
```

Or with Docker Compose (local / same LAN as the plug):

```bash
docker compose up -d
```

The `compose.yml` reads `.env` and maps `${PORT:-3000}`.

### Docker on a remote server (WireGuard)

Use `compose.server.yml` when the app runs on a VPS or other host that is **not** on your home LAN. It runs [gluetun](https://github.com/qdm12/gluetun) as a WireGuard client so the app can reach `TAPO_DEVICE_IP` over your home network.

Setup follows gluetun's [custom WireGuard provider](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/custom.md#wireguard) docs: `VPN_SERVICE_PROVIDER=custom`, `VPN_TYPE=wireguard`, and a `wg0.conf` file bind-mounted to `/gluetun/wireguard/wg0.conf`.

1. Enable WireGuard on your home router or VPN server and create a **client peer** for this host.
2. Copy the WireGuard config example and fill in your keys:

   ```bash
   cp wireguard/wg0.conf.example wireguard/wg0.conf
   chmod 600 wireguard/wg0.conf
   ```

   - Set `AllowedIPs` to your home LAN subnet (e.g. `192.168.1.0/24`). Do **not** use `0.0.0.0/0` unless you intend to route all traffic through home — split routing keeps ntfy and Postmark working over normal internet egress.
   - Set `Endpoint` to your home **public IP address and port** (gluetun does not support hostnames for the endpoint; resolve DDNS to an IP if needed).

   Alternatively, you can pass WireGuard settings via gluetun environment variables (`WIREGUARD_ENDPOINT_IP`, `WIREGUARD_PRIVATE_KEY`, etc.) instead of a config file — see the gluetun wiki linked above.

3. Set `TAPO_DEVICE_IP` in `.env` to the plug's **LAN** address and reserve that IP in your router's DHCP settings.
4. Set `API_KEY` in `.env` if you expose the HTTP port on the server.
5. Deploy:

   ```bash
   docker compose -f compose.server.yml up -d
   docker compose -f compose.server.yml logs -f tapo-power-alert
   ```

6. Verify the tunnel can reach the plug (replace with your `TAPO_DEVICE_IP`):

   ```bash
   docker compose -f compose.server.yml exec tapo-power-alert ping -c 3 192.168.1.100
   ```

### Laravel Forge

See [`forge/README.md`](forge/README.md) for Nginx reverse-proxy template, deploy script, Docker permissions for the `forge` user, shared paths for `wireguard/wg0.conf`, and SSL.

## Project structure

```
tapo-power-alert/
├── server.js        # everything lives here
├── package.json
├── .env.example
├── Dockerfile
├── compose.yml           # local / same-LAN deploy
├── compose.server.yml    # remote server + WireGuard (gluetun)
├── forge/                # Laravel Forge nginx template + deploy script
├── wireguard/
│   └── wg0.conf.example
└── README.md
```

## Security

- Never commit `.env` (it's in `.gitignore`)
- `chmod 600 .env`
- Use a random `NTFY_TOPIC` — anyone who knows the name can subscribe
- Set `API_KEY` if the server is reachable beyond localhost
- Tapo credentials are only used for local device communication

## Advanced

### Multiple dryers

Run one instance per plug on different ports:

```bash
TAPO_DEVICE_IP=192.168.1.100 PORT=3000 NTFY_TOPIC=dryer-1 bun run server.js
TAPO_DEVICE_IP=192.168.1.101 PORT=3001 NTFY_TOPIC=dryer-2 bun run server.js
```

### Scripting

```bash
POWER=$(curl -s http://localhost:3000/status | jq '.power')
echo "Current power: ${POWER}W"
```

## License

MIT
