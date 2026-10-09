# RemoteType serve 公网服务端镜像
# 构建：docker build -t remotetype-server:latest server/
# 运行：见 server/DEPLOY.md（数据/日志挂载 + 内存上限 + 可选 RT_TOKEN）

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先只拷 package 清单再装依赖：src 变动不击穿 npm 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# data/ logs/ 是运行时写入目录（RecordStore / Logger 默认路径）。
# 预建并交给 node 用户：命名卷首次挂载会继承镜像内目录属主，
# 不这样做的话挂载进来的卷是 root:root，USER node 写不进去。
RUN mkdir -p /app/data /app/logs && chown -R node:node /app

USER node
EXPOSE 8790

CMD ["node", "src/server.js"]
