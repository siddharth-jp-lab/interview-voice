FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json ./
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
EXPOSE 8080
CMD ["node", "server/index.js"]
