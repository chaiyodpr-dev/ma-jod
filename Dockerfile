# One container = one meeting. The Playwright image already has Chromium and
# its system libraries; keep its tag in step with the playwright version in
# package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
COPY src ./src

VOLUME /app/recordings
ENTRYPOINT ["node", "src/bot.js"]
