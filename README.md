# Tapo Power Alert

A small Bun server that watches a Tapo P110 smart plug and sends a push notification when your dryer finishes.

**New here?** Start with [QUICKSTART.md](QUICKSTART.md) — you'll be running in 10 minutes.

## Features

- Monitors Tapo P110 power draw over your local network (no cloud polling)
- Push notifications via [ntfy](https://ntfy.sh) — works on multiple phones from one topic
- Optional email backup via Postmark
- Detects real "finished" state, not just the cooling phase
- Validates Tapo credentials on startup
- Lightweight single-file app (`server.js`)

## Prerequisites

| Item | Notes |
|------|-------|
| Tapo P110 | Plugged into the dryer's power supply |
| Bun | [bun.sh](https://bun.sh) |
| ntfy app | Free on [iOS](https://apps.apple.com/app/ntfy/id1625396347) and [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) |
| Postmark account | Optional — only if you want email too |

## Installation

```bash
curl -fsSL https://bun.sh/install | bash

git clone <your-repo-url>
cd tapo-power-alert

cp .env.example .env
# edit .env — see Configuration below
```

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
COOLDOWN_READINGS=3       # consecutive off readings before alert
CHECK_INTERVAL=60         # seconds between checks
PORT=3000
```

### Optional — API security

```bash
API_KEY=your-secret-key
```

When set, `/check`, `/status`, `/state`, and `/reset` require `Authorization: Bearer your-secret-key` or `?key=your-secret-key`.

## Usage

```bash
bun run dev      # development (auto-reload)
bun run start    # production
```

On startup the server connects to your P110 and prints whether push/email are configured.

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

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /` | — | Simple health check |
| `GET /health` | — | Health check with timestamp |
| `GET /status` | API key | Current power draw from P110 |
| `GET /state` | API key | In-memory monitoring state |
| `GET /check` | API key | Run one detection cycle now |
| `GET /reset` | API key | Reset monitoring state (for testing) |

```bash
curl http://localhost:3000/status
curl -H "Authorization: Bearer your-secret-key" http://localhost:3000/state
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

### Credential validation failed

- Confirm `TAPO_DEVICE_IP` matches your router's device list
- Use the same email/password as the Tapo app
- Ping the device: `ping 192.168.1.100`
- Server and plug must be on the same network

### No push notification

- Both phones must subscribe to the exact `NTFY_TOPIC` in the ntfy app
- Check server logs for `📱 Push notification sent via ntfy`
- Test manually: `curl -d "test" https://ntfy.sh/your-topic-name`

### No email

- Verify Postmark token and that `EMAIL_FROM` is verified in Postmark
- Check spam folder

### Missed notification after server restart

State is in-memory only. If the server restarts mid-cycle it may miss that cycle. It will catch the next one.

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

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "run", "start"]
```

```bash
docker build -t tapo-power-alert .
docker run -d --env-file .env tapo-power-alert
```

## Project structure

```
tapo-power-alert/
├── server.js        # everything lives here
├── package.json
├── .env.example
├── QUICKSTART.md    # start here
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
