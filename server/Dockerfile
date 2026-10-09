FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# build context 是 repo 根，所以从 server/ 子目录拷入
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/public ./public

# data/ logs/ 是运行时写入目录（RecordStore / Logger 默认路径）。
# 预建并交给 node 用户：命名卷首次挂载会继承镜像内目录属主。
RUN mkdir -p /app/data /app/logs && chown -R node:node /app

USER node
EXPOSE 8790

CMD ["node", "src/server.js"]
