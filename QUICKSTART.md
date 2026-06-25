# Quick Start

Get push notifications on your phone when the dryer finishes. Takes about 10 minutes.

## What you need

- A **Tapo P110** smart plug on the dryer's power
- A computer on the same home network (Mac, Linux, Raspberry Pi, etc.)
- **[Bun](https://bun.sh)** installed
- The **[ntfy](https://ntfy.sh)** app on each phone (free)

## 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

## 2. Configure

```bash
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

Everything else has sensible defaults. Email via Postmark is optional — see `.env.example` if you want it as a backup.

**Find the P110 IP:** open your router's admin page → connected devices → look for the Tapo plug.

## 3. Set up phones

On **each phone**:

1. Install **ntfy** ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. Tap **+** → **Subscribe to topic**
3. Enter your `NTFY_TOPIC` name (e.g. `dryer-finished-xK9m2pQ`)
4. Tap **Subscribe**

Both phones are done. One alert reaches everyone subscribed to the topic.

## 4. Run

```bash
bun run start
```

You should see:

```
✅ Credentials validated successfully!
📱 Push notifications enabled: https://ntfy.sh/dryer-finished-xK9m2pQ
🚀 Tapo Power Alert running on http://localhost:3000
```

If credential validation fails, double-check `TAPO_DEVICE_IP` and your Tapo login.

## 5. Verify

```bash
curl http://localhost:3000/status    # current power draw
curl http://localhost:3000/state      # monitoring state
```

Run a dryer cycle and watch the logs. When it finishes you should get a push on both phones within a few minutes.

## How it detects "finished"

1. Dryer heats up → power goes above **1500W** (cycle started)
2. Dryer cools down → power drops to 100–300W (still running, no alert)
3. Dryer stops → power drops below **50W**
4. After **3 consecutive checks** at that low level (~3 minutes), push notification fires
5. One notification per cycle

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Connection failed | Check `TAPO_DEVICE_IP` in router; ping the device |
| No push notification | Confirm both phones subscribed to the exact `NTFY_TOPIC` |
| Alert too early | Increase `COOLDOWN_READINGS` or `OFF_THRESHOLD` in `.env` |
| Alert too late | Decrease `COOLDOWN_READINGS` or `CHECK_INTERVAL` in `.env` |
| Missed alert after restart | Server lost in-memory state — it'll catch the next cycle |

## Run on boot (optional)

See [README.md](README.md) for systemd and Docker setup.

## More detail

See [README.md](README.md) for all configuration options, API endpoints, and tuning.
