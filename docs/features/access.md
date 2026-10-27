# Access control

Markon does not require accounts. Permission comes from explicit capabilities, not network origin:

- an **administrator** holds a short-lived `HttpOnly` admin session;
- every other browser is a **collaborator**, governed by review scope, advanced workspace switches, and an optional collaborator access code;
- loopback, proxy IPs, and `X-Forwarded-For` never grant admin status.

## Explicit admin sessions

Administrators may change flags and aliases, commit or checkout, and create/delete files. Source editing and saving require Edit to be enabled. Service-level workspace registration, removal, and shutdown remain on the local GUI/CLI control socket.

```bash
markon admin open  # one-time fragment nonce, valid for 60 seconds
markon admin code  # pairing code for SSH/headless use, valid for 5 minutes
```

Both produce the same 12-hour session, invalidated by service restart. Long-lived management credentials stay in the protected lock file/native process and never enter HTML, URLs, JavaScript, or browser storage.

## Collaborator capabilities

Reading, navigation, Search, Annotate, Progress, Export Notes, Fold, and Print are essential after workspace access. Edit enables source saving, Chat enables Workspace AI, Live enables synchronized presentation, and Share selects common annotations and section Progress. With Share off, non-admin browsers persist isolated Personal review data; an admin session is not required for basic review. Collaborators cannot change flags or aliases, commit/checkout, create/delete files, register/detach workspaces, or stop the service.

## Collaborator access codes

An access code gates every non-admin browser in its scope. It is application-level access control, not encryption; public deployment still needs HTTPS and a [reverse proxy](/advanced/reverse-proxy).

A workspace-specific code overrides the global code. If neither exists, collaborators enter without a gate. Configure a workspace code in the desktop app or CLI:

```bash
markon --collaborator-access-code guest-secret README.md
```

Only a salted hash is persisted. Successful unlock writes a scope-specific, HMAC-signed cookie for about 30 days. It survives restarts; repeated failures trigger increasing source-IP cooldowns.

## Host and Origin boundary

Every request must match an exact Host allowlist. Custom DNS and proxy origins must be registered:

```bash
markon --public-base-url https://docs.example.com
markon --trusted-host https://docs.example.com
```

Unknown Hosts return 421. Mutations and WebSockets also require matching Origin and Host authorities. Proxy headers are informational and do not establish Viewer, Collaborator, or Admin identity.

## Local CLI management

The CLI's management token can run `markon set`, `markon ls`, `markon detach`, and `markon shutdown` through the local control socket. See [Command-line options](/guide/cli).
