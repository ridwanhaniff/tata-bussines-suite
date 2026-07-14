# ════════════════════════════════════════════════════════════
# Tata Business Suite — Production Dockerfile
# Target: Railway / HuggingFace Spaces / Cloud (NOT Nixpacks)
# Node.js 20 + Chromium for whatsapp-web.js
# ════════════════════════════════════════════════════════════

FROM node:20-slim

# ── 1. Chromium + System Dependencies ─────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    postgresql-client \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── 2. Install Node.js Dependencies ──────────────────────────
COPY package*.json ./

# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD harus SEBELUM npm install
# agar postinstall puppeteer tidak mendownload Chromium (~300MB)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

RUN npm install -g npm@11 \
    && npm install --no-audit --no-fund \
    && npm cache clean --force

# ── 3. Copy Source Code ───────────────────────────────────────
COPY . .

# ── 4. Memory Limit (before build) ─────────────────────────────
# 320MB agar masih ada ~192MB untuk Chromium (~150-300MB) + OS
# dalam total 512MB RAM HF Space
ENV NODE_OPTIONS="--max-old-space-size=320" \
    NODE_ENV=production

# ── 5. Build Frontend (SPA) ────────────────────────────────────
RUN npm run build:frontend

# ── 6. Runtime Env ─────────────────────────────────────────────
ENV PORT=7860 \
    HOME=/tmp

# ── 7. Permissions + Temp Directories ─────────────────────────
RUN chmod -R 777 /app \
    && mkdir -p /tmp/.config /tmp/.cache \
    && chmod -R 777 /tmp

# ── 8. Health Check ───────────────────────────────────────────
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:7860/ping').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

EXPOSE 7860

# ── 9. Start ──────────────────────────────────────────────────
CMD ["node", "index.js"]
