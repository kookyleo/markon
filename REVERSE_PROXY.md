# 反向代理配置指南

当使用 `--shared-annotation` 模式时，需要确保反向代理正确支持 WebSocket 连接。

## Nginx 配置

```nginx
server {
    listen 80;
    server_name md.example.com;

    location / {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 支持
    location /ws {
        proxy_pass http://127.0.0.1:6419/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # WebSocket 超时设置
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## Caddy 配置

```caddy
md.example.com {
    reverse_proxy localhost:6419
}
```

Caddy 自动处理 WebSocket 升级，无需额外配置。

## Apache 配置

```apache
<VirtualHost *:80>
    ServerName md.example.com

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:6419/
    ProxyPassReverse / http://127.0.0.1:6419/

    # WebSocket 支持
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:6419/$1" [P,L]

    <Location "/ws">
        ProxyPass ws://127.0.0.1:6419/ws
        ProxyPassReverse ws://127.0.0.1:6419/ws
    </Location>
</VirtualHost>
```

需要启用模块：
```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite
```

## Traefik 配置

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

Traefik 自动处理 WebSocket 升级。

## 故障排查

### 错误码 1006 - 连接异常关闭

如果看到 WebSocket 连接成功但立即断开（错误码 1006），通常是反向代理配置问题：

1. **检查 WebSocket 升级头**：
   ```bash
   # 使用 curl 测试 WebSocket 握手
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: test" \
        http://md.example.com/ws
   ```

   应该看到 `101 Switching Protocols` 响应。

2. **检查代理超时设置**：
   确保 WebSocket 连接不会因为超时而断开。

3. **查看代理日志**：
   ```bash
   # Nginx
   tail -f /var/log/nginx/error.log

   # Caddy
   journalctl -u caddy -f
   ```

### 调试 WebSocket 连接

在浏览器开发者工具中：
1. 打开 **Network** 标签
2. 切换到 **WS** (WebSocket) 子标签
3. 查看 WebSocket 连接的状态和消息

在浏览器控制台中查看详细日志：
- `[WebSocket] Page protocol:` - 当前页面协议
- `[WebSocket] WS URL:` - WebSocket 连接 URL
- `[WebSocket] Connected successfully` - 连接成功
- `[WebSocket] Disconnected (code: ...)` - 断开原因

## HTTPS/SSL 配置

如果使用 HTTPS，确保：

1. **使用 wss:// 协议**：代码会自动检测并使用 `wss://`
2. **SSL 证书有效**：WebSocket 连接使用相同的 SSL 证书
3. **代理配置正确**：

```nginx
server {
    listen 443 ssl http2;
    server_name md.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:6419;
        # ... 其他配置
    }

    location /ws {
        proxy_pass http://127.0.0.1:6419/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # ... 其他配置
    }
}
```

## 本地测试

不使用反向代理时，直接访问：
```bash
markon README.md --shared-annotation
# 访问 http://localhost:6419
```

WebSocket 应该正常工作（`ws://localhost:6419/ws`）。
