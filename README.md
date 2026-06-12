# Tapo Power Alert

A single-file Bun server that monitors your Tapo P110 energy monitor and sends notifications when your dryer finishes running.

## Features

- 🔌 Monitors Tapo P110 energy usage via local KLAP protocol
- 🔐 Validates credentials on startup (immediate feedback if configuration is wrong)
- 📧 Sends email notifications when dryer stops drawing power
- ⚡ Simple threshold-based detection (default: 500W)
- 💾 Runs entirely in-memory (no disk I/O needed)
- 🔄 Runs on a scheduled interval (default: every 5 minutes)
- 📊 Manual status checking via HTTP endpoints
- 🚀 Fast and lightweight - powered by Bun
- 📦 Single-file architecture - everything in `server.js`

## Prerequisites

1. A Tapo P110 energy monitoring smart plug
2. Bun runtime (https://bun.sh)
3. A Postmark account for sending emails (or modify to use other email services)

## Installation

1. **Install Bun:**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd tapo-power-alert
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your settings:
   ```bash
   # Tapo credentials
   TAPO_EMAIL=your_tapo_email@example.com
   TAPO_PASSWORD=your_tapo_password
   TAPO_DEVICE_IP=192.168.1.100

   # Email settings
   EMAIL_FROM=noreply@yourdomain.com
   EMAIL_TO=your_email@example.com
   POSTMARK_API_TOKEN=your_postmark_api_token

   # Monitoring settings
   RUNNING_THRESHOLD=500         # Watts above which dryer is "running"
   COOLDOWN_READINGS=3           # Number of consecutive low readings before notification
   CHECK_INTERVAL=300            # Seconds between checks (300 = 5 min)

   # Server settings
   PORT=44044
   ```

## Usage

### Development
```bash
bun run dev
```

### Production
```bash
bun run start
```

### Running as a service (systemd)

Create a service file at `/etc/systemd/system/tapo-power-alert.service`:
```ini
[Unit]
Description=Tapo Power Alert Service
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

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable tapo-power-alert
sudo systemctl start tapo-power-alert
sudo systemctl status tapo-power-alert
```

### Running with Docker (optional)

Create a `Dockerfile`:
```dockerfile
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production

CMD ["bun", "run", "start"]
```

Build and run:
```bash
docker build -t tapo-power-alert .
docker run -d -p 3000:3000 --env-file .env tapo-power-alert
```

## API Endpoints

- `GET /` - Health check
- `GET /health` - Detailed health check with timestamp
- `GET /check` - Manually trigger a dryer status check
- `GET /status` - Get current Tapo device status
- `GET /state` - Get current in-memory monitoring state
- `GET /reset` - Reset monitoring state (useful after testing)

## How It Works

The monitor uses a simple, reliable approach:

1. **Power Reading**: Every configured interval, check the P110's current power draw
2. **State Comparison**: Compare current power with previous reading (stored in memory)
3. **Detection Logic**:
   - If previous power was **above threshold** (default: 500W) AND current power is **below threshold**, count as a "low reading"
   - After `COOLDOWN_READINGS` consecutive low readings, send notification
   - If power goes back above threshold, reset the counter and prepare for next cycle
4. **One Notification Per Cycle**: Only sends one notification per drying cycle

## Why This Approach?

### Simpler Than Time-Based Detection
Traditional approaches use time-based detection (e.g., "wait 10 minutes after power drops"), but this has issues:
- Too fast: False positives from dryer pausing
- Too slow: Delayed notifications
- Doesn't account for varying drying times

### Power Transition Detection
This approach detects the **transition** from running to stopped:
- **More reliable**: Detects the moment dryer actually stops
- **Fast**: Notification sent as soon as dryer is confirmed stopped
- **Flexible**: Works regardless of drying time
- **Prevents false positives**: Multiple consecutive readings confirm dryer is stopped

### In-Memory State
- **No disk I/O**: Faster, no file corruption risk
- **Cleaner**: Simpler code, no state file management
- **Acceptable tradeoff**: State resets on server restart, but that's fine for this use case

## Configuration

### RUNNING_THRESHOLD
The power level (in watts) that indicates the dryer is running.

**Recommended settings:**
- **Default**: 500W
- **Higher (700-1000W)**: Reduces false positives, but may miss very light loads
- **Lower (200-400W)**: More sensitive, but may detect small fluctuations

**Typical dryer power levels:**
- Off/Standby: 0-10W
- Running (heating): 2000-5000W
- Running (cooling only): 100-300W

### COOLDOWN_READINGS
Number of consecutive low power readings before sending notification. Prevents false positives from temporary power fluctuations.

**Recommended settings:**
- **Default**: 3 readings
- **With 5-minute intervals**: 3 readings = 15 minutes wait time
- **More (5-7)**: Very conservative, delays notification but prevents false positives
- **Less (1-2)**: Faster notifications, but may trigger on temporary pauses

**Examples:**
- `CHECK_INTERVAL=300` (5 min) + `COOLDOWN_READINGS=3` = 15 minutes minimum after stop
- `CHECK_INTERVAL=60` (1 min) + `COOLDOWN_READINGS=3` = 3 minutes minimum after stop

### CHECK_INTERVAL
How often to check power (in seconds).

**Recommended settings:**
- **Default**: 300 seconds (5 minutes)
- **Faster (60-120)**: Quicker notifications, more device communication
- **Slower (600-900)**: Less network traffic, but slower detection

## Troubleshooting

### Startup validation issues

**Missing environment variables:**
```
❌ Missing required environment variables:
   • TAPO_EMAIL
   • TAPO_PASSWORD
   • TAPO_DEVICE_IP

Please create a .env file with these variables. See .env.example for details.
```
**Solution:** Create `.env` file with required variables (copy from `.env.example`)

**Credential validation failed:**
```
❌ Credential validation failed!
   Error: Invalid server hash in handshake1. Check credentials.

Please check:
   • TAPO_DEVICE_IP is correct (check router DHCP table)
   • TAPO_EMAIL is your Tapo account email
   • TAPO_PASSWORD is correct
   • Device is powered on and connected to your network
   • Server can reach the device (try: ping <TAPO_DEVICE_IP>)
```
**Solutions:**
- Verify IP address is correct (check router's connected devices list)
- Ensure device is powered on and connected to WiFi
- Confirm Tapo account credentials are correct
- Ping the device: `ping <TAPO_DEVICE_IP>`
- Check that server and device are on same network/subnet

### "Device not found" or "Connection failed" (during monitoring)
- Ensure your P110 is on and connected to your network
- Verify the IP address is correct (check your router's DHCP table)
- Check that your Tapo credentials are correct
- Make sure the server can reach the device's IP
- Try pinging the device: `ping <TAPO_DEVICE_IP>`

### Email not sending
- Verify Postmark Server API Token is correct
- Check that sender email is verified in Postmark
- Check spam folder
- Review server logs

### False notifications
- Increase `COOLDOWN_READINGS` to require more consecutive low readings
- Increase `RUNNING_THRESHOLD` if dryer's cooling phase triggers alerts
- Check if your dryer has multiple heating phases

### Missed notifications (dryer finished but no alert)
- Decrease `RUNNING_THRESHOLD` if drying power varies
- Check if dryer enters a long cooling phase
- Decrease `COOLDOWN_READINGS` for faster notifications
- Check server logs to see power readings

### Too frequent notifications
- The notification flag resets when power goes back above threshold
- Ensure `COOLDOWN_READINGS` is high enough (default: 3)
- Check if your dryer has auto-restart features

### Device connection issues
- Ensure the device is on the same network as the server
- Check firewall settings - the server needs to reach the device on port 80
- Try pinging the device IP from the server
- Check that the device is not in a VLAN that isolates it

## Monitoring and Debugging

### View Current State
```bash
curl http://localhost:3000/state
```

This shows:
- Previous power reading
- Consecutive low readings count
- Whether notification was sent for current cycle
- First check flag

### Manual Check
```bash
curl http://localhost:3000/check
```

### Reset State (useful after testing)
```bash
curl http://localhost:3000/reset
```

### View Logs
```bash
# If running with systemd
sudo journalctl -u tapo-power-alert -f

# If running in terminal
# Logs are printed to stdout/stderr
```

## Performance

- **Memory**: ~50MB typical usage (in-memory state, no disk I/O)
- **CPU**: Minimal, only spikes during device communication
- **Network**: Very low bandwidth, only communicates with Tapo device and email API
- **Disk**: Zero - all state is in-memory
- **Code**: Single file (~500 lines), easy to understand and modify

## Project Structure

```
tapo-power-alert/
├── server.js          # Single file with everything (server, protocol, monitoring)
├── package.json       # Bun configuration
├── README.md          # This file
├── QUICKSTART.md      # Quick start guide
└── .env.example      # Environment variables template
```

That's it! Everything you need is in `server.js`.

## Security Notes

- Environment variables should never be committed to version control
- The `.env` file should be protected (chmod 600)
- Use strong, unique passwords for your Tapo account
- Consider using a dedicated email account for notifications
- The server only reads energy data from your Tapo device
- No sensitive data is logged beyond what's necessary
- Tapo credentials are used for local device authentication only

## Customization

### Email Service
Currently uses Postmark. To use a different service, modify the `sendNotification()` function in `server.js`:
- SendGrid
- AWS SES
- Mailgun
- Custom SMTP server

### Notification Methods
Extend the notification system to include:
- SMS via Twilio
- Push notifications via services like Pushover
- Slack/Discord webhooks
- Home Assistant integration
- Custom webhooks

### Add Multiple Thresholds
You could add logic to detect different phases:
- Heating phase: > 2000W
- Cooling phase: 100-500W
- Off: < 100W

Example logic could send different notifications for each phase.

## Advanced Usage

### Multiple Dryers
Run multiple instances on different ports:
```bash
# Dryer 1
TAPO_DEVICE_IP=192.168.1.100 PORT=3000 EMAIL_TO=dryer1@email.com bun run server.js

# Dryer 2  
TAPO_DEVICE_IP=192.168.1.101 PORT=3001 EMAIL_TO=dryer2@email.com bun run server.js
```

### Integration with Other Systems
Call the API endpoints from other systems:
```bash
# Get current power in a script
POWER=$(curl -s http://localhost:3000/status | jq '.power')
echo "Current power: $POWER watts"
```

## License

MIT License - feel free to modify and extend for your needs!
