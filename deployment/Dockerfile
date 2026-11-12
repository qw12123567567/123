FROM node:24-bookworm-slim
WORKDIR /app
ENV APP_ENV=production HOST=0.0.0.0 PORT=10000 DATA_DIR=/var/data TZ=Asia/Shanghai
COPY --chown=node:node *.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /var/data && chown node:node /var/data
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:10000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
