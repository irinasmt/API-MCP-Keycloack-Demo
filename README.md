# API-MCP-Keycloak Demo

Simple demo showing OAuth token forwarding between an MCP server and REST API using Keycloak.

## Architecture

```
User → Keycloak (OAuth) → Access Token
                              ↓
                    [Single token for both]
                              ↓
                 ┌────────────┴────────────┐
                 ↓                         ↓
            MCP Server                  REST API
         (validates token)          (validates token)
         (forwards token) ──────────→
```

## Components

- **Keycloak**: OAuth 2.0 server (port 8080)
- **API**: Product CRUD REST API (port 3000)
- **MCP**: Tool server with view/edit only (port 3002)

## Quick Start

**Easy way (automated):**

```powershell
.\start.ps1
```

This script will:

- Create `.env` files if missing
- Install dependencies
- Start both API and MCP servers in new windows
- Add MCP to VS Code configuration

**Manual way:**

1. Start Keycloak:

```bash
docker-compose up -d
```

2. Configure Keycloak (see [Keycloak Setup](#keycloak-setup))

3. Start API:

```bash
cd api
bun install
bun run dev
```

4. Start MCP:

```bash
cd mcp
bun install
bun run dev
```

## Keycloak Setup

1. Open http://localhost:8080
2. Login: `admin` / `admin`
3. Create realm: `master`
4. Create client: `api-mcp-client`
   - Client authentication: ON
   - Valid redirect URIs: `*`
   - Save and copy credentials
5. Update `.env` files with client ID and secret

## Usage

Get token:

```bash
curl -X POST http://localhost:8080/realms/demo/protocol/openid-connect/token \
  -d "client_id=api-mcp-client" \
  -d "client_secret=YOUR_SECRET" \
  -d "grant_type=client_credentials"
```

Use token with API:

```bash
curl http://localhost:3000/products \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Use token with MCP (via VS Code or Claude Desktop)
