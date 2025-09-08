FROM node:18 as base

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

FROM node:18-alpine AS production

RUN apk update && apk upgrade && \
    apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

COPY --from=base --chown=nodejs:nodejs /usr/src/app/node_modules ./node_modules

COPY --chown=nodejs:nodejs . .

# Create logs directory with proper permissions
RUN mkdir -p /app/logs && chown -R nodejs:nodejs /app/logs

USER nodejs

EXPOSE 5000

CMD ["npm", "start"]