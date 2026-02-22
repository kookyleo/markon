# Reverse Proxy Configuration Guide

When using `--shared-annotation` mode, ensure your reverse proxy correctly supports WebSocket connections.

## System Path Overview

Markon uses `&amp;#x2F;_&amp;#x2F;` as a unified prefix for all system resources to avoid conflicts with user file paths:

- `&amp;#x2F;_&amp;#x2F;ws` - WebSocket endpoint (shared-annotation mode only)
- `&amp;#x2F;_&amp;#x2F;css&amp;#x2F;*` - CSS stylesheets
- `&amp;#x2F;_&amp;#x2F;js&amp;#x2F;*` - JavaScript files
- `&amp;#x2F;_&amp;#x2F;favicon.svg` - Favicon (SVG format)
- `&amp;#x2F;_&amp;#x2F;favicon.ico` - Favicon (ICO format, redirects to SVG)

**Important:** Users can create any files or directories (including `ws&amp;#x2F;`, `static&amp;#x2F;`, etc.) without conflicts.

---

## Nginx Configuration

The simplest approach is to proxy all system resources under `&amp;#x2F;_&amp;#x2F;` at once:

```nginx
server {
    listen 80;
    server_name md.example.com;

    # System resources (WebSocket, CSS, JS, Favicon)
    location &amp;#x2F;_&amp;#x2F; {
        proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection &amp;quot;upgrade&amp;quot;;

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
    location &amp;#x2F; {
        proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419;
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
- All path proxying (including `&amp;#x2F;_&amp;#x2F;` system paths)

---

## Apache Configuration

### Complete Configuration

```apache
&amp;lt;VirtualHost *:80&amp;gt;
    ServerName md.example.com

    # Enable proxy
    ProxyPreserveHost On
    ProxyRequests Off

    # WebSocket support
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^&amp;#x2F;_&amp;#x2F;ws$ &amp;quot;ws:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;_&amp;#x2F;ws&amp;quot; [P,L]

    # WebSocket connection
    &amp;lt;Location &amp;quot;&amp;#x2F;_&amp;#x2F;ws&amp;quot;&amp;gt;
        ProxyPass ws:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;_&amp;#x2F;ws
        ProxyPassReverse ws:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;_&amp;#x2F;ws
    &amp;lt;&amp;#x2F;Location&amp;gt;

    # System resources (CSS, JS, Favicon)
    &amp;lt;Location &amp;quot;&amp;#x2F;_&amp;#x2F;&amp;quot;&amp;gt;
        ProxyPass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;_&amp;#x2F;
        ProxyPassReverse http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;_&amp;#x2F;
    &amp;lt;&amp;#x2F;Location&amp;gt;

    # User files (root path)
    &amp;lt;Location &amp;quot;&amp;#x2F;&amp;quot;&amp;gt;
        ProxyPass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;
        ProxyPassReverse http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;
    &amp;lt;&amp;#x2F;Location&amp;gt;
&amp;lt;&amp;#x2F;VirtualHost&amp;gt;
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
      rule: &amp;quot;Host(`md.example.com`)&amp;quot;
      service: markon

  services:
    markon:
      loadBalancer:
        servers:
          - url: &amp;quot;http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;quot;
```

**Note:** Traefik automatically handles:
- WebSocket upgrades
- All path proxying (including `&amp;#x2F;_&amp;#x2F;` system paths)

---

## HTTPS&amp;#x2F;SSL Configuration

### Nginx HTTPS Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name md.example.com;

    ssl_certificate &amp;#x2F;path&amp;#x2F;to&amp;#x2F;cert.pem;
    ssl_certificate_key &amp;#x2F;path&amp;#x2F;to&amp;#x2F;key.pem;

    # System resources (including WebSocket)
    location &amp;#x2F;_&amp;#x2F; {
        proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection &amp;quot;upgrade&amp;quot;;

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
    location &amp;#x2F; {
        proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419;
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
    return 301 https:&amp;#x2F;&amp;#x2F;$server_name$request_uri;
}
```

**Important:**
1. Markon automatically detects HTTPS and uses `wss:&amp;#x2F;&amp;#x2F;` protocol for WebSocket
2. Ensure SSL certificate is valid; WebSocket uses the same certificate

---

## Troubleshooting

### Error 1006 - Connection Closed Abnormally

If WebSocket connects but immediately disconnects (error 1006), it&amp;#x27;s usually a reverse proxy configuration issue:

#### 1. Check WebSocket Upgrade Headers

```bash
# Test WebSocket handshake
curl -i -N -H &amp;quot;Connection: Upgrade&amp;quot; -H &amp;quot;Upgrade: websocket&amp;quot; \
     -H &amp;quot;Sec-WebSocket-Version: 13&amp;quot; \
     -H &amp;quot;Sec-WebSocket-Key: test&amp;quot; \
     http:&amp;#x2F;&amp;#x2F;md.example.com&amp;#x2F;_&amp;#x2F;ws
```

Should see `101 Switching Protocols` response.

#### 2. Check System Resources

```bash
# Test CSS loading
curl -I http:&amp;#x2F;&amp;#x2F;md.example.com&amp;#x2F;_&amp;#x2F;css&amp;#x2F;editor.css

# Test JS loading
curl -I http:&amp;#x2F;&amp;#x2F;md.example.com&amp;#x2F;_&amp;#x2F;js&amp;#x2F;editor.js

# Test Favicon
curl -I http:&amp;#x2F;&amp;#x2F;md.example.com&amp;#x2F;_&amp;#x2F;favicon.svg
```

All should return `200 OK`.

#### 3. Check Proxy Timeout Settings

Ensure WebSocket connections don&amp;#x27;t disconnect due to timeouts:
- Nginx: `proxy_read_timeout 3600s;`
- Apache: Default timeout usually sufficient
- Caddy&amp;#x2F;Traefik: Automatically handled

#### 4. Check Proxy Logs

```bash
# Nginx
tail -f &amp;#x2F;var&amp;#x2F;log&amp;#x2F;nginx&amp;#x2F;error.log

# Apache
tail -f &amp;#x2F;var&amp;#x2F;log&amp;#x2F;apache2&amp;#x2F;error.log

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
- `[WebSocket] Page protocol: https:, WS URL: wss:&amp;#x2F;&amp;#x2F;...&amp;#x2F;_&amp;#x2F;ws` - Protocol auto-detection
- `[WebSocket] Sent file path: README.md` - Sending file path
- `[WebSocket] Connected successfully` - Connection successful
- `[WebSocket] Connection stable, reset reconnect counter` - Connection stable
- `[WebSocket] Disconnected (code: ...)` - Disconnect reason

### Common Issues

#### Static Resources 404

If CSS&amp;#x2F;JS fail to load, check:
1. Is reverse proxy correctly configured for `&amp;#x2F;_&amp;#x2F;` path?
2. Is `proxy_pass` URL correct? (Note trailing slash)

```nginx
# Correct
location &amp;#x2F;_&amp;#x2F; {
    proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419;
}

# Wrong (causes path concatenation issues)
location &amp;#x2F;_&amp;#x2F; {
    proxy_pass http:&amp;#x2F;&amp;#x2F;127.0.0.1:6419&amp;#x2F;;
}
```

#### WebSocket Protocol Mismatch

If you see &amp;quot;Mixed Content&amp;quot; errors:
- HTTPS pages must use `wss:&amp;#x2F;&amp;#x2F;` protocol
- Markon handles this automatically
- Ensure reverse proxy correctly passes `X-Forwarded-Proto` header

---

## Local Testing

Without reverse proxy, access directly:

```bash
# Local mode (no WebSocket)
markon README.md
# Visit http:&amp;#x2F;&amp;#x2F;localhost:6419

# Shared annotation mode (WebSocket enabled)
markon README.md --shared-annotation
# WebSocket URL: ws:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;ws
```

### Verify System Resources

Access in browser:
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;css&amp;#x2F;editor.css` - CSS file
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;js&amp;#x2F;editor.js` - JS file
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;favicon.svg` - Favicon
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;ws` - WebSocket (shared-annotation mode only)

### Verify No User File Conflicts

Create test directories and files:
```bash
mkdir -p ws static css js
echo &amp;quot;# Test&amp;quot; &amp;gt; ws&amp;#x2F;test.md
echo &amp;quot;# Static&amp;quot; &amp;gt; static&amp;#x2F;readme.md
```

Access:
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;ws&amp;#x2F;test.md` ✅ User file
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;static&amp;#x2F;readme.md` ✅ User file
- `http:&amp;#x2F;&amp;#x2F;localhost:6419&amp;#x2F;_&amp;#x2F;ws` ✅ System WebSocket (no conflict!)

---

## Summary

### Recommended Configuration

- **Nginx**: Proxy all system resources under `location &amp;#x2F;_&amp;#x2F;`
- **Caddy**: Default configuration works
- **Apache**: Configure `&amp;#x2F;_&amp;#x2F;` path as shown in examples
- **Traefik**: Default configuration works

### Key Points

1. ✅ **System paths**: All system resources under `&amp;#x2F;_&amp;#x2F;`
2. ✅ **No conflicts**: Users can create any files&amp;#x2F;directories
3. ✅ **WebSocket**: Shared annotation mode requires `&amp;#x2F;_&amp;#x2F;ws` support
4. ✅ **HTTPS**: Automatically uses `wss:&amp;#x2F;&amp;#x2F;` protocol
5. ✅ **Simple config**: Most proxies only need one `location &amp;#x2F;_&amp;#x2F;` rule
