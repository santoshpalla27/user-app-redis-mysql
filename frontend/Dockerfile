# Build stage
FROM node:18 AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Set environment variable
ENV REACT_APP_API_URL=https://backend.santosh.website

# Build the application
RUN npm run build

# Production stage
FROM nginx:1.25-alpine AS production


# Install security updates
RUN apk update && apk upgrade && \
    apk add --no-cache curl && \
    rm -rf /var/cache/apk/*

# Copy built files from build stage
COPY --from=build /app/build /usr/share/nginx/html

# Copy custom nginx configuration (optional)
COPY nginx.conf /etc/nginx/nginx.conf

RUN addgroup -g 1001 -S nginx_group && \
    adduser -S nginx_user -u 1001 -G nginx_group

# Change ownership of nginx files
RUN chown -R nginx_user:nginx_group /usr/share/nginx/html && \
    chown -R nginx_user:nginx_group /var/cache/nginx && \
    chown -R nginx_user:nginx_group /var/log/nginx && \
    chown -R nginx_user:nginx_group /etc/nginx/conf.d

# Create nginx PID directory
RUN mkdir -p /var/run/nginx && \
    chown -R nginx_user:nginx_group /var/run/nginx

# Switch to non-root user
USER nginx_user

# Expose port 3000
EXPOSE 3000

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
