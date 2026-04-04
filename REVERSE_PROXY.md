# Reverse Proxy Configuration Guide

When using `--shared-annotation` mode, ensure your reverse proxy correctly supports WebSocket connections.

## System Path Overview

Markon uses `/_/` as a unified prefix for all system resources to avoid conflicts with user file paths:

- `/_/ws` - WebSocket endpoint (shared-annotation mode only)
- `/_/css/*` - CSS stylesheets
- `/_/js/*` - JavaScript files
- `/_/favicon.svg` - Favicon (SVG format)
- `/_/favicon.ico` - Favicon (ICO format, redirects to SVG)

**Important:** Users can create any files or directories (including `ws/`, `static/`, etc.) without conflicts.

---

## Nginx Configuration

The simplest approach is to proxy all system resources under `/_/` at once:

```nginx
server {
    listen 80;
    server_name md.example.com;

    # System resources (WebSocket, CSS, JS, Favicon)
    location /_/ {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # General headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout (no effect on static resources)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # User files (Markdown, directories, etc.)
    location / {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Caddy Configuration

Caddy automatically handles WebSocket upgrades and all paths with a simple configuration:

```caddy
md.example.com {
    reverse_proxy localhost:6419
}
```

**Note:** Caddy automatically handles:
- WebSocket upgrades (no extra configuration needed)
- HTTPS certificates (automatic issuance and renewal)
- All path proxying (including `/_/` system paths)

---

## Apache Configuration

### Complete Configuration

```apache
<VirtualHost *:80>
    ServerName md.example.com

    # Enable proxy
    ProxyPreserveHost On
    ProxyRequests Off

    # WebSocket support
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/_/ws$ "ws://127.0.0.1:6419/_/ws" [P,L]

    # WebSocket connection
    <Location "/_/ws">
        ProxyPass ws://127.0.0.1:6419/_/ws
        ProxyPassReverse ws://127.0.0.1:6419/_/ws
    </Location>

    # System resources (CSS, JS, Favicon)
    <Location "/_/">
        ProxyPass http://127.0.0.1:6419/_/
        ProxyPassReverse http://127.0.0.1:6419/_/
    </Location>

    # User files (root path)
    <Location "/">
        ProxyPass http://127.0.0.1:6419/
        ProxyPassReverse http://127.0.0.1:6419/
    </Location>
</VirtualHost>
```

### Required Modules

```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite
systemctl restart apache2
```

---

## Traefik Configuration

```yaml
http:
  routers:
    markon:
      rule: "Host(`md.example.com`)"
      service: markon

  services:
    markon:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:6419"
```

**Note:** Traefik automatically handles:
- WebSocket upgrades
- All path proxying (including `/_/` system paths)

---

## HTTPS/SSL Configuration

### Nginx HTTPS Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name md.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # System resources (including WebSocket)
    location /_/ {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # General headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # User files
    location / {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP to HTTPS redirect
server {
    listen 80;
    server_name md.example.com;
    return 301 https://$server_name$request_uri;
}
```

**Important:**
1. Markon automatically detects HTTPS and uses `wss://` protocol for WebSocket
2. Ensure SSL certificate is valid; WebSocket uses the same certificate

---

## Troubleshooting

### Error 1006 - Connection Closed Abnormally

If WebSocket connects but immediately disconnects (error 1006), it's usually a reverse proxy configuration issue:

#### 1. Check WebSocket Upgrade Headers

```bash
# Test WebSocket handshake
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: test" \
     http://md.example.com/_/ws
```

Should see `101 Switching Protocols` response.

#### 2. Check System Resources

```bash
# Test CSS loading
curl -I http://md.example.com/_/css/editor.css

# Test JS loading
curl -I http://md.example.com/_/js/editor.js

# Test Favicon
curl -I http://md.example.com/_/favicon.svg
```

All should return `200 OK`.

#### 3. Check Proxy Timeout Settings

Ensure WebSocket connections don't disconnect due to timeouts:
- Nginx: `proxy_read_timeout 3600s;`
- Apache: Default timeout usually sufficient
- Caddy/Traefik: Automatically handled

#### 4. Check Proxy Logs

```bash
# Nginx
tail -f /var/log/nginx/error.log

# Apache
tail -f /var/log/apache2/error.log

# Caddy
journalctl -u caddy -f
```

### Debugging WebSocket Connections

#### Browser Developer Tools

1. Open **Network** tab
2. Switch to **WS** (WebSocket) sub-tab
3. View WebSocket connection status and messages

#### Browser Console Logs

Check detailed WebSocket logs:
- `[WebSocket] Page protocol: https:, WS URL: wss://.../_/ws` - Protocol auto-detection
- `[WebSocket] Sent file path: README.md` - Sending file path
- `[WebSocket] Connected successfully` - Connection successful
- `[WebSocket] Connection stable, reset reconnect counter` - Connection stable
- `[WebSocket] Disconnected (code: ...)` - Disconnect reason

### Common Issues

#### Static Resources 404

If CSS/JS fail to load, check:
1. Is reverse proxy correctly configured for `/_/` path?
2. Is `proxy_pass` URL correct? (Note trailing slash)

```nginx
# Correct
location /_/ {
    proxy_pass http://127.0.0.1:6419;
}

# Wrong (causes path concatenation issues)
location /_/ {
    proxy_pass http://127.0.0.1:6419/;
}
```

#### WebSocket Protocol Mismatch

If you see "Mixed Content" errors:
- HTTPS pages must use `wss://` protocol
- Markon handles this automatically
- Ensure reverse proxy correctly passes `X-Forwarded-Proto` header

---

## Local Testing

Without reverse proxy, access directly:

```bash
# Local mode (no WebSocket)
markon README.md
# Visit http://localhost:6419

# Shared annotation mode (WebSocket enabled)
markon README.md --shared-annotation
# WebSocket URL: ws://localhost:6419/_/ws
```

### Verify System Resources

Access in browser:
- `http://localhost:6419/_/css/editor.css` - CSS file
- `http://localhost:6419/_/js/editor.js` - JS file
- `http://localhost:6419/_/favicon.svg` - Favicon
- `http://localhost:6419/_/ws` - WebSocket (shared-annotation mode only)

### Verify No User File Conflicts

Create test directories and files:
```bash
mkdir -p ws static css js
echo "# Test" > ws/test.md
echo "# Static" > static/readme.md
```

Access:
- `http://localhost:6419/ws/test.md` ✅ User file
- `http://localhost:6419/static/readme.md` ✅ User file
- `http://localhost:6419/_/ws` ✅ System WebSocket (no conflict!)

---

## Summary

### Recommended Configuration

- **Nginx**: Proxy all system resources under `location /_/`
- **Caddy**: Default configuration works
- **Apache**: Configure `/_/` path as shown in examples
- **Traefik**: Default configuration works

### Key Points

1. ✅ **System paths**: All system resources under `/_/`
2. ✅ **No conflicts**: Users can create any files/directories
3. ✅ **WebSocket**: Shared annotation mode requires `/_/ws` support
4. ✅ **HTTPS**: Automatically uses `wss://` protocol
5. ✅ **Simple config**: Most proxies only need one `location /_/` rule
