# Quick Start Guide

Tapo Power Alert is a **single-file Bun application** - everything is in `server.js`.

## 1. Prerequisites

- Bun runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- A Tapo P110 smart plug connected to your network
- A Postmark account (or other email service)

## 2. Install and Configure

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone and navigate to the project
cd tapo-power-alert

# Copy environment template
cp .env.example .env

# Edit .env with your settings
nano .env
```

Required `.env` variables:
```bash
TAPO_EMAIL=your_email@example.com
TAPO_PASSWORD=your_password
TAPO_DEVICE_IP=192.168.1.100  # Find your P110's IP in router
EMAIL_FROM=noreply@yourdomain.com
EMAIL_TO=your@email.com
POSTMARK_API_TOKEN=your_token

# Optional (defaults shown)
RUNNING_THRESHOLD=500     # Watts - dryer is running if above this
COOLDOWN_READINGS=3       # Consecutive low readings before alert
CHECK_INTERVAL=300        # Seconds between checks (300 = 5 min)
PORT=3000
```

## 3. Run

```bash
# Development (with auto-reload)
bun run dev

# Production
bun run start
```

**Note:** On startup, the server validates your Tapo credentials:
- ✅ Success: "Credentials validated successfully!"
- ❌ Failure: Detailed error message with troubleshooting steps

If validation fails, fix the issues and restart the server. The server will keep running but monitoring won't work until credentials are valid.

## 4. Verify

```bash
# Check health
curl http://localhost:3000/health

# Get device status
curl http://localhost:3000/status

# Manual check
curl http://localhost:3000/check

# View monitoring state
curl http://localhost:3000/state

# Reset state (for testing)
curl http://localhost:3000/reset
```

## How It Works

The monitor detects when your dryer stops by watching for the power to drop:

1. Checks power every 5 minutes (configurable)
2. If power was above 500W and now below 500W, counts as "low reading"
3. After 3 consecutive low readings (15 minutes total), sends notification
4. Only one notification per drying cycle

**Simple. Reliable. Fast.**

## 5. (Optional) Run as a System Service

See `README.md` for detailed systemd and Docker setup instructions.

## Troubleshooting

**Connection failed?**
- Check device IP in router
- Ensure device is on same network
- Ping the device: `ping <device_ip>`

**No email?**
- Check Postmark API token
- Verify sender email in Postmark dashboard
- Check spam folder

**False alerts?**
- Increase `COOLDOWN_READINGS` to 5 or 7
- Increase `RUNNING_THRESHOLD` to 700 or 1000

**Missed alerts?**
- Decrease `RUNNING_THRESHOLD` to 300 or 400
- Decrease `COOLDOWN_READINGS` to 1 or 2
- Check logs to see power readings

## Need More Info?

See `README.md` for comprehensive documentation.
