# 反向代理配置指南

当使用 `--shared-annotation` 模式时，需要确保反向代理正确支持 WebSocket 连接。

## 访问控制

**Markon 本身不做任何身份认证。** 凡是能访问到该 URL 的人，都可以读取工作区里的所有文件；开启 `--shared-annotation` 或 `--edit` 后，他们同样可以写入。

通过反向代理对外暴露时，**必须在网关层加上认证**，否则工作区对公网完全开放。常见方案：

- **HTTP Basic Auth（nginx）** — 最简单，个人或小团队首选：

  ```nginx
  server {
      listen 443 ssl http2;
      server_name md.example.com;
      # ... SSL 证书 ...

      location / {
          auth_basic           "Markon";
          auth_basic_user_file /etc/nginx/.htpasswd;   # htpasswd -c /etc/nginx/.htpasswd <用户名>

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

- **OAuth2 / SSO** — 在 Markon 上游挂一个 [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)。
- **零信任隧道** — Cloudflare Access 或 Tailscale Funnel，流量到达服务器之前已完成身份验证。
- **网络层隔离** — Tailscale、WireGuard，或直接只绑本地（`--host 127.0.0.1`），适合单人或完全私有部署。

> 目前 Markon 应用层不支持「只读公开共享」。若需对外提供只读视图，须在代理层限制写入方法（禁止 `PUT`/`POST`/`DELETE`），或关闭 `--shared-annotation` 与 `--edit`。

## 系统路径说明

Markon 使用 `/_/` 作为系统资源的统一前缀，避免与用户文件路径冲突：

- `/_/ws` - WebSocket 连接端点（仅 shared-annotation 模式）
- `/_/css/*` - CSS 样式文件
- `/_/js/*` - JavaScript 脚本文件
- `/_/favicon.svg` - 网站图标（SVG 格式）
- `/_/favicon.ico` - 网站图标（ICO 格式，重定向到 SVG）

**重要：** 用户可以创建任何文件或目录（包括 `ws/`、`static/` 等），不会与系统路径冲突。

---

## Nginx 配置

最简单的配置方式，一次性代理所有 `/_/` 下的系统资源：

```nginx
server {
    listen 80;
    server_name md.example.com;

    # 系统资源（包括 WebSocket、CSS、JS、Favicon）
    location /_/ {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 通用头部
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 超时设置（对静态资源无影响）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 用户文件（Markdown、目录等）
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

## Caddy 配置

Caddy 会自动处理 WebSocket 升级和所有路径，配置非常简单：

```caddy
md.example.com {
    reverse_proxy localhost:6419
}
```

**说明：** Caddy 自动处理：
- WebSocket 升级（无需额外配置）
- HTTPS 证书（自动申请和续期）
- 所有路径代理（包括 `/_/` 系统路径）

---

## Apache 配置

### 完整配置

```apache
<VirtualHost *:80>
    ServerName md.example.com

    # 启用代理
    ProxyPreserveHost On
    ProxyRequests Off

    # WebSocket 支持
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/_/ws$ "ws://127.0.0.1:6419/_/ws" [P,L]

    # WebSocket 连接
    <Location "/_/ws">
        ProxyPass ws://127.0.0.1:6419/_/ws
        ProxyPassReverse ws://127.0.0.1:6419/_/ws
    </Location>

    # 系统资源（CSS、JS、Favicon）
    <Location "/_/">
        ProxyPass http://127.0.0.1:6419/_/
        ProxyPassReverse http://127.0.0.1:6419/_/
    </Location>

    # 用户文件（根路径）
    <Location "/">
        ProxyPass http://127.0.0.1:6419/
        ProxyPassReverse http://127.0.0.1:6419/
    </Location>
</VirtualHost>
```

### 需要启用的模块

```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite
systemctl restart apache2
```

---

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

**说明：** Traefik 自动处理：
- WebSocket 升级
- 所有路径代理（包括 `/_/` 系统路径）

---

## HTTPS/SSL 配置

### Nginx HTTPS 配置

```nginx
server {
    listen 443 ssl http2;
    server_name md.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # 系统资源（包括 WebSocket）
    location /_/ {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 通用头部
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 用户文件
    location / {
        proxy_pass http://127.0.0.1:6419;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name md.example.com;
    return 301 https://$server_name$request_uri;
}
```

**重要：**
1. Markon 会自动检测 HTTPS 并使用 `wss://` 协议连接 WebSocket
2. 确保 SSL 证书有效，WebSocket 连接使用相同的证书

---

## 故障排查

### 错误码 1006 - 连接异常关闭

如果 WebSocket 连接成功但立即断开（错误码 1006），通常是反向代理配置问题：

#### 1. 检查 WebSocket 升级头

```bash
# 测试 WebSocket 握手
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: test" \
     http://md.example.com/_/ws
```

应该看到 `101 Switching Protocols` 响应。

#### 2. 检查系统资源是否正常

```bash
# 测试 CSS 加载
curl -I http://md.example.com/_/css/editor.css

# 测试 JS 加载
curl -I http://md.example.com/_/js/editor.js

# 测试 Favicon
curl -I http://md.example.com/_/favicon.svg
```

都应该返回 `200 OK`。

#### 3. 检查代理超时设置

确保 WebSocket 连接不会因为超时而断开：
- Nginx: `proxy_read_timeout 3600s;`
- Apache: 默认超时通常够用
- Caddy/Traefik: 自动处理

#### 4. 查看代理日志

```bash
# Nginx
tail -f /var/log/nginx/error.log

# Apache
tail -f /var/log/apache2/error.log

# Caddy
journalctl -u caddy -f
```

### 调试 WebSocket 连接

#### 浏览器开发者工具

1. 打开 **Network** 标签
2. 切换到 **WS** (WebSocket) 子标签
3. 查看 WebSocket 连接的状态和消息

#### 浏览器控制台日志

查看详细的 WebSocket 日志：
- `[WebSocket] Page protocol: https:, WS URL: wss://.../_/ws` - 协议自动检测
- `[WebSocket] Sent file path: README.md` - 发送文件路径
- `[WebSocket] Connected successfully` - 连接成功
- `[WebSocket] Connection stable, reset reconnect counter` - 连接稳定
- `[WebSocket] Disconnected (code: ...)` - 断开原因

### 常见问题

#### 静态资源 404

如果 CSS/JS 无法加载，检查：
1. 反向代理是否正确配置了 `/_/` 路径
2. `proxy_pass` URL 是否正确（注意尾部斜杠）

```nginx
# 正确
location /_/ {
    proxy_pass http://127.0.0.1:6419;
}

# 错误（会导致路径拼接问题）
location /_/ {
    proxy_pass http://127.0.0.1:6419/;
}
```

#### WebSocket 协议不匹配

如果看到 "Mixed Content" 错误：
- HTTPS 页面必须使用 `wss://` 协议
- Markon 已自动处理，无需手动配置
- 确保反向代理正确传递 `X-Forwarded-Proto` 头

---

## 本地测试

不使用反向代理时，直接访问：

```bash
# 本地模式（无 WebSocket）
markon README.md
# 访问 http://localhost:6419

# 共享注释模式（启用 WebSocket）
markon README.md --shared-annotation
# WebSocket URL: ws://localhost:6419/_/ws
```

### 验证系统资源

在浏览器中访问：
- `http://localhost:6419/_/css/editor.css` - CSS 文件
- `http://localhost:6419/_/js/editor.js` - JS 文件
- `http://localhost:6419/_/favicon.svg` - Favicon
- `http://localhost:6419/_/ws` - WebSocket（仅 shared-annotation 模式）

### 验证用户文件无冲突

创建测试目录和文件：
```bash
mkdir -p ws static css js
echo "# Test" > ws/test.md
echo "# Static" > static/readme.md
```

访问：
- `http://localhost:6419/ws/test.md` ✅ 用户文件
- `http://localhost:6419/static/readme.md` ✅ 用户文件
- `http://localhost:6419/_/ws` ✅ 系统 WebSocket（不冲突！）

---

## 总结

### 推荐配置

- **Nginx**: 统一代理 `location /_/` 下的所有系统资源
- **Caddy**: 默认配置即可
- **Apache**: 按示例配置 `/_/` 路径
- **Traefik**: 默认配置即可

### 关键要点

1. ✅ **系统路径**：所有系统资源都在 `/_/` 下
2. ✅ **无冲突**：用户可以创建任何文件/目录
3. ✅ **WebSocket**：共享注释模式需要 `/_/ws` 支持
4. ✅ **HTTPS**：自动使用 `wss://` 协议
5. ✅ **简单配置**：大多数反向代理只需要一个 `location /_/` 规则
