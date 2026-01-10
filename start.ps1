#!/usr/bin/env pwsh

Write-Host "🚀 Starting Product API & MCP Server..." -ForegroundColor Green

# Check if .env files exist
if (-not (Test-Path "api\.env")) {
    Write-Host "⚠️  Creating api/.env from .env.example..." -ForegroundColor Yellow
    Copy-Item "api\.env.example" "api\.env"
}

if (-not (Test-Path "mcp\.env")) {
    Write-Host "⚠️  Creating mcp/.env from .env.example..." -ForegroundColor Yellow
    Copy-Item "mcp\.env.example" "mcp\.env"
}

# Start API server
Write-Host "Starting Product API on port 3000..." -ForegroundColor Cyan
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd api; bun install; bun run dev" -WindowStyle Normal

# Wait a bit for API to start
Start-Sleep -Seconds 2

# Start MCP server
Write-Host "Starting MCP Server on port 3002..." -ForegroundColor Cyan
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd mcp; bun install; bun run dev" -WindowStyle Normal

# Update VS Code MCP config
$mcpConfigPath = "$env:APPDATA\Code\User\mcp.json"
Write-Host "`nUpdating VS Code MCP configuration..." -ForegroundColor Cyan

if (Test-Path $mcpConfigPath) {
    $config = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
    
    # Check if product-mcp already exists
    if (-not $config.servers.'product-mcp') {
        $config.servers | Add-Member -MemberType NoteProperty -Name "product-mcp" -Value @{
            url = "http://localhost:3002"
            type = "http"
        } -Force
        
        $config | ConvertTo-Json -Depth 10 | Set-Content $mcpConfigPath
        Write-Host "✅ Added product-mcp to VS Code MCP configuration" -ForegroundColor Green
    } else {
        Write-Host "✅ product-mcp already configured in VS Code" -ForegroundColor Green
    }
} else {
    Write-Host "⚠️  VS Code MCP config not found at $mcpConfigPath" -ForegroundColor Yellow
    Write-Host "Creating new configuration..." -ForegroundColor Yellow
    
    $newConfig = @{
        servers = @{
            "product-mcp" = @{
                url = "http://localhost:3002"
                type = "http"
            }
        }
        inputs = @()
    }
    
    New-Item -ItemType Directory -Path (Split-Path $mcpConfigPath) -Force | Out-Null
    $newConfig | ConvertTo-Json -Depth 10 | Set-Content $mcpConfigPath
    Write-Host "✅ Created VS Code MCP configuration" -ForegroundColor Green
}

Write-Host "`n✨ Servers starting in new windows!" -ForegroundColor Green
Write-Host "API: http://localhost:3000" -ForegroundColor White
Write-Host "MCP: http://localhost:3002" -ForegroundColor White
Write-Host "`n💡 Remember to:" -ForegroundColor Yellow
Write-Host "  1. Start Keycloak: docker-compose up -d" -ForegroundColor White
Write-Host "  2. Configure Keycloak (see README.md)" -ForegroundColor White
Write-Host "  3. Update .env files with client secret" -ForegroundColor White
Write-Host "  4. Reload VS Code to pick up MCP changes" -ForegroundColor White
