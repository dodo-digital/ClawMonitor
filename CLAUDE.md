@AGENTS.md

## Deployment

The dashboard runs on this VPS as a bare node process (no systemd service).

- **URL**: `http://ubuntu-4gb-ash-1:18801` (Tailscale: `http://ubuntu-4gb-ash-1.tail1d5130.ts.net:18801`)
- **Process**: `node build/server/index.js` (port 18801)
- **Logs**: `/tmp/clawmonitor.log`
- **Database**: `~/.openclaw/dashboard.sqlite`

To deploy after code changes, use `/deploy` or run: `npm run build && npx vite build`, kill the old process on 18801, and start a new one with `nohup node build/server/index.js > /tmp/clawmonitor.log 2>&1 &`.
