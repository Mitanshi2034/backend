# Backend image for Render.
# Based on Microsoft's official Playwright image: Node.js + Chromium + every system
# library Chromium needs. The tag MUST match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    HEADLESS=true

# Install dependencies first so this layer is cached when only source files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render sets PORT itself; 4000 is only the local default.
EXPOSE 4000
CMD ["node", "src/index.js"]
