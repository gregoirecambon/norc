FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
RUN pnpm build

FROM nginx:alpine
ENV NORC_API_URL=http://server:3001
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
