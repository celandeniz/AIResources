# Playwright base image ships Chromium + system deps — the service itself is a
# thin express shim on top.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm install playwright@1.49.1 --omit=dev

COPY server.js ./

ENV PORT=4600
EXPOSE 4600
CMD ["node", "server.js"]
