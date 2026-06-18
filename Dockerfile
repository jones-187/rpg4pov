# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# 编译 CLI wrapper 到 dist/（含 dist/cli + dist/lib，保证 import 链完整）
RUN pnpm build:cli

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV WORKSPACE_ROOT=/app/data/workspaces
ENV USE_BUILTIN_RIPGREP=0
ENV SHELL=/bin/bash

# alpine musl 适配：装 ripgrep（claude bundled ripgrep 是 glibc 编译）+ bash
RUN apk add --no-cache ripgrep bash

# 装 claude code CLI（固定版本，避免自动升级导致不兼容）
# v1.0.0 不支持 --bare/--settings/精细路径 allowedTools，v2+ 支持更完善的权限管控
RUN npm install -g @anthropic-ai/claude-code@2.1.181

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/data/workspaces /app/claude /home/nextjs/.claude \
 && chown -R nextjs:nodejs /app/data /app/claude /home/nextjs/.claude

# 写受控 settings.json 到 /app/claude/settings.json（不放 workspace，运行时只读）
# 内容来自 src/lib/claude-settings.ts 的 CLAUDE_SETTINGS_JSON，此处内联（构建时写死）
COPY --chown=nextjs:nodejs <<'SETTINGS' /app/claude/settings.json
{
  "env": {
    "USE_BUILTIN_RIPGREP": "0"
  },
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Write(./.env)",
      "Write(./.env.*)",
      "Write(./secrets/**)"
    ],
    "allow": [
      "Read(./story.md)",
      "Read(./world.md)",
      "Read(./player.md)",
      "Read(./rules.md)",
      "Read(./turn/input.md)",
      "Read(./actors/**)",
      "Read(./logs/**)",
      "Write(./turn/output.md)",
      "Write(./turn/done.json)",
      "Write(./world.md)",
      "Write(./player.md)",
      "Write(./actors/**)",
      "Write(./logs/**)",
      "Bash(node /app/cli/roll-choice.js:*)"
    ]
  }
}
SETTINGS

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# 复制 CLI 工具到 /app/cli/（从 dist/ 编译产物复制，对 agent 隐藏 dist/ 编译细节）
COPY --from=builder --chown=nextjs:nodejs /app/dist/cli ./cli
# 复制 dist/lib（roll-choice.js 的 import 依赖链）
COPY --from=builder --chown=nextjs:nodejs /app/dist/lib ./dist/lib

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
