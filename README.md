# User Record Management App

A full-stack application demonstrating how to use React, Node.js, MySQL, and Redis Cluster for managing user records.

## Features

- **Dual Storage Options**: Store user records in either MySQL database or Redis Cluster
- **View Records**: Separate views for MySQL and Redis data
- **Synchronization**: Sync data between MySQL and Redis
- **CRUD Operations**: Create, read, update, and delete user records in both storage systems
- **Containerized**: Fully containerized with Docker Compose

## Technologies Used

- **Frontend**: React, React Router, Axios
- **Backend**: Node.js, Express.js
- **Databases**: MySQL, Redis Cluster (Bitnami)
- **Containerization**: Docker, Docker Compose

## Project Structure

```
user-record-app/
├── docker-compose.yml      # Main docker-compose file
├── frontend/               # React frontend application
│   ├── Dockerfile
│   ├── package.json
│   ├── public/
│   └── src/
│       ├── components/     # React components
│       │   ├── Dashboard.js
│       │   ├── UserForm.js
│       │   ├── MySQLUsers.js
│       │   └── RedisUsers.js
│       ├── App.js
│       ├── App.css
│       ├── index.js
│       └── index.css
├── backend/                # Node.js backend application
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js           # Express server
│   └── init.sql            # MySQL initialization script
```

## Running the Application

1. **Clone the repository**

2. **Start the application with Docker Compose**

```bash
docker-compose up -d
```

3. **Access the application**

- Frontend: http://localhost:3000
- Backend API: http://localhost:5000

4. **Stopping the application**

```bash
docker-compose down
```

## API Endpoints

### MySQL Endpoints

- `GET /api/mysql/users` - Get all users from MySQL
- `GET /api/mysql/users/:id` - Get a specific user from MySQL
- `POST /api/mysql/users` - Create a new user in MySQL
- `PUT /api/mysql/users/:id` - Update a user in MySQL
- `DELETE /api/mysql/users/:id` - Delete a user from MySQL

### Redis Endpoints

- `GET /api/redis/users` - Get all users from Redis
- `GET /api/redis/users/:id` - Get a specific user from Redis
- `POST /api/redis/users` - Create a new user in Redis
- `PUT /api/redis/users/:id` - Update a user in Redis
- `DELETE /api/redis/users/:id` - Delete a user from Redis

### Sync Endpoints

- `POST /api/mysql-to-redis` - Copy all users from MySQL to Redis
- `POST /api/redis-to-mysql` - Copy all users from Redis to MySQL

## Redis Cluster

The application uses a 6-node Redis Cluster with 3 master nodes and 3 replica nodes for high availability and data sharding. The cluster is initialized automatically by the `cluster-init` service in the Docker Compose file.