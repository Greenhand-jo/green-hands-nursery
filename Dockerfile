FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY dist/ ./dist/
RUN mkdir -p /data
EXPOSE 3000
CMD ["node","server.mjs"]
