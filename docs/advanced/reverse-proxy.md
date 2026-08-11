# Reverse proxy

Use Nginx, Apache, or Caddy to expose Markon through a public domain.

## Access control

Markon never treats source IP as identity. Browsers are collaborators unless they hold an explicit admin session, collaborator codes apply to every non-admin browser, and each request must match an exact Host allowlist. Register the public origin with `--entry https://docs.example.com` or `--trusted-host https://docs.example.com`; unknown Hosts return 421.

A collaborator code is application-level access control, not transport encryption. Public deployments should terminate TLS and preferably add gateway authentication such as Basic Auth, oauth2-proxy, Cloudflare Access, Tailscale, or WireGuard.

## Markon configuration

```bash
markon --host 127.0.0.1 -p 6419 \
  -b https://docs.example.com \
  --entry https://docs.example.com
```

`--host` keeps the service local, `-b` opens the public URL, and `--entry` controls advertised/QR URLs, the Host allowlist, and Secure cookies for HTTPS origins. The proxy supplies TLS.

## Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name docs.example.com;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:6419;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
  }
}
```

WebSocket upgrade is required for Shared and Live.

## Apache

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl
```

```apache
<VirtualHost *:443>
  ServerName docs.example.com
  SSLEngine on
  SSLCertificateFile /path/to/fullchain.pem
  SSLCertificateKeyFile /path/to/privkey.pem
  RewriteEngine on
  RewriteCond %{HTTP:Upgrade} websocket [NC]
  RewriteCond %{HTTP:Connection} upgrade [NC]
  RewriteRule ^/?(.*) "ws://127.0.0.1:6419/$1" [P,L]
  ProxyPass / http://127.0.0.1:6419/
  ProxyPassReverse / http://127.0.0.1:6419/
</VirtualHost>
```

## Caddy

```text
docs.example.com {
  reverse_proxy 127.0.0.1:6419
}
```

Caddy handles HTTPS and WebSocket forwarding automatically.

## systemd

`markon` initializes/connects to `markond` and then exits, so use a oneshot unit:

```ini
[Service]
Type=oneshot
RemainAfterExit=yes
User=markon
WorkingDirectory=/srv/docs
ExecStart=/usr/local/bin/markon /srv/docs --host 127.0.0.1 -p 6419 --entry https://docs.example.com
ExecStop=/usr/local/bin/markon shutdown
Environment="MARKON_SQLITE_PATH=/var/lib/markon/annotation.sqlite"
```

## Reserved path and troubleshooting

`/_/` is reserved for internal CSS, JavaScript, and WebSockets; do not create a workspace-root directory named `_`. If WebSockets fail, verify Upgrade/Connection headers and proxy timeouts. If QR uses a private IP, correct `--entry`. For a blank page, check `curl http://127.0.0.1:6419` and the proxy error log.
