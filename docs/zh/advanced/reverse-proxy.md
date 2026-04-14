# 反向代理

本文介绍如何通过 Nginx / Apache / Caddy 把 Markon 暴露到公网域名下。

## 为什么需要反向代理

- **绑定域名** — 用 `docs.example.com` 替代 `http://192.168.1.5:6419`
- **HTTPS** — 通过代理层终止 TLS
- **统一入口** — 多个内部服务共用 80/443 端口

## Markon 侧配置

让 Markon 只监听本地，由代理转发：

```bash
markon --host 127.0.0.1 -p 6419 \
  -b https://docs.example.com \
  --qr https://docs.example.com \
  --enable-search \
  --shared-annotation
```

关键点：

- `--host 127.0.0.1` — 仅本地访问，安全
- `-b` / `--qr` — 用公网 URL，不然浏览器打开的还是内网 IP

## Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name docs.example.com;

  ssl_certificate     /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:6419;
    proxy_http_version 1.1;

    # WebSocket 支持（共享标注需要）
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 透传请求头
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket 长连接保活
    proxy_read_timeout 86400;
  }
}
```

## Apache

启用模块：

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl
```

VirtualHost 配置：

```apache
<VirtualHost *:443>
  ServerName docs.example.com

  SSLEngine on
  SSLCertificateFile    /path/to/fullchain.pem
  SSLCertificateKeyFile /path/to/privkey.pem

  # WebSocket (共享标注)
  RewriteEngine on
  RewriteCond %{HTTP:Upgrade} websocket [NC]
  RewriteCond %{HTTP:Connection} upgrade [NC]
  RewriteRule ^/?(.*) "ws://127.0.0.1:6419/$1" [P,L]

  ProxyPass        / http://127.0.0.1:6419/
  ProxyPassReverse / http://127.0.0.1:6419/
</VirtualHost>
```

## Caddy

最简配置：

```caddyfile
docs.example.com {
  reverse_proxy 127.0.0.1:6419
}
```

Caddy 自动处理 HTTPS（Let's Encrypt）和 WebSocket，无需额外配置。

## Systemd 服务

把 Markon 托管为系统服务，开机自启：

```ini
# /etc/systemd/system/markon.service
[Unit]
Description=Markon Markdown Renderer
After=network.target

[Service]
Type=simple
User=markon
WorkingDirectory=/srv/docs
ExecStart=/usr/local/bin/markon \
  --host 127.0.0.1 -p 6419 \
  --enable-search --shared-annotation \
  -b https://docs.example.com \
  --qr https://docs.example.com
Restart=on-failure
Environment="MARKON_SQLITE_PATH=/var/lib/markon/annotations.db"

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl enable --now markon
```

## 系统路径前缀

Markon 使用 `/_/` 作为内部资源的保留前缀（CSS、JS、WebSocket）。在反向代理时：

✅ **可以**正常代理：不需要特殊配置
❌ **不要**在工作区根目录创建名为 `_` 的文件夹（单下划线）

注意只有精确的 `/_/` 会冲突，`_build/`、`__pycache__/` 等不受影响。

## 故障排查

### WebSocket 连不上

- 确认代理配置中加了 `Upgrade` 和 `Connection: upgrade` 头
- Nginx 需要 `proxy_read_timeout` 够长（默认 60s 会断线）

### QR 码打开的是内网 IP

- 检查 `--qr` 参数是否传了正确的公网 URL

### 浏览器打开空白

- 检查 Markon 进程是否真的在跑：`curl http://127.0.0.1:6419`
- 检查代理错误日志：Nginx 是 `/var/log/nginx/error.log`
