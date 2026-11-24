FROM node:20-alpine
WORKDIR /app
COPY relayer/package.json relayer/package-lock.json* ./
RUN npm install --omit=dev
COPY relayer/ ./
COPY config/ /config/
ENV CONFIG_PATH=/config/config.json
ENV DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/index.js"]
