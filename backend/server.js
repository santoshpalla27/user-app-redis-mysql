const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const cors = require('cors');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// MySQL Connection Pool
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'mysql',
  user: process.env.MYSQL_USER || 'user',
  password: process.env.MYSQL_PASSWORD || 'password',
  database: process.env.MYSQL_DATABASE || 'userdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Parse Redis nodes from environment
const redisNodes = (process.env.REDIS_NODES ||
  'redis-node-0:6379,redis-node-1:6379,redis-node-2:6379,redis-node-3:6379,redis-node-4:6379,redis-node-5:6379')
  .split(',')
  .map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port, 10) };
  });

// Redis password
const redisPassword = process.env.REDIS_PASSWORD || 'bitnami123';

// Standalone Redis clients (for keys scanning)
const redisStandaloneClients = [];

let redisClusterClient = null;
let redisConnected = false;

// Utility: delay helper
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Dispose existing cluster client safely
async function disposeClusterClient() {
  try {
    if (redisClusterClient && redisClusterClient.isOpen) {
      console.log('Closing existing Redis cluster client...');
      await redisClusterClient.quit();
      redisClusterClient = null;
      redisConnected = false;
    }
  } catch (err) {
    console.error('Error quitting Redis cluster client:', err);
  }
}

// Create and connect Redis cluster client with delay for stability
async function createClusterClient() {
  await disposeClusterClient();

  const client = redis.createCluster({
    rootNodes: redisNodes.map(node => ({
      url: `redis://:${redisPassword}@${node.host}:${node.port}`
    })),
    defaults: {
      password: redisPassword
    }
  });

  client.on('error', (err) => {
    console.error('Redis Cluster Error:', err);
    redisConnected = false;
  });

  await client.connect();

  console.log('Connected to Redis Cluster, waiting 15 seconds for cluster topology stabilization...');
  await wait(15000);

  redisConnected = true;
  console.log('✅ Redis cluster ready');

  return client;
}

// Initialize standalone and cluster Redis clients
const initRedis = async () => {
  if (redisStandaloneClients.length === 0) {
    for (const node of redisNodes) {
      const client = redis.createClient({
        url: `redis://:${redisPassword}@${node.host}:${node.port}`
      });
      client.on('error', err => console.error(`Standalone Redis node ${node.host}:${node.port} error:`, err));
      await client.connect();
      console.log(`Connected to Redis standalone node ${node.host}:${node.port}`);
      client.nodeInfo = node;
      redisStandaloneClients.push(client);
    }
  }

  redisClusterClient = await createClusterClient();
};

// Wrapper for Redis cluster commands with retries and reconnects on slot errors
async function redisClusterCommandWrapper(commandFn, maxRetries = 5, delayMs = 3000) {
  if (!redisConnected || !redisClusterClient || !redisClusterClient.isOpen) {
    throw new Error('Redis cluster client is not connected');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Redis cluster command attempt ${attempt}.`);
      return await commandFn(redisClusterClient);
    } catch (err) {
      // Check for known cluster slot/connection errors
      if (
        err.message.includes("Cannot read properties of undefined (reading 'master')") ||
        err.message.includes('Slot is not served by any node') ||
        err.message.includes('CLUSTERDOWN')
      ) {
        console.warn(`Redis cluster slot error on attempt ${attempt}: ${err.message}`);
        try {
          console.log('Reconnecting Redis cluster client to refresh slot cache and state...');
          await disposeClusterClient();
          redisClusterClient = await createClusterClient();
          await wait(delayMs);
        } catch (reconnectErr) {
          console.error('Error reconnecting Redis cluster client:', reconnectErr);
          if (attempt === maxRetries) throw reconnectErr;
          await wait(delayMs);
        }
        continue; // Retry after reconnect
      }
      throw err; // Unexpected errors
    }
  }
  throw new Error('Max Redis cluster retries exceeded');
}

// Helper: scan keys across all standalone clients
async function getAllKeysFromCluster(pattern) {
  if (!redisConnected || redisStandaloneClients.length === 0) return [];
  const allKeys = [];
  try {
    for (const client of redisStandaloneClients) {
      if (client.isOpen) {
        const keys = await client.keys(pattern);
        allKeys.push(...keys);
      }
    }
    return allKeys;
  } catch (err) {
    console.error('Error scanning Redis keys:', err);
    return [];
  }
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    await initRedis();
  } catch (err) {
    console.error('Redis initialization failed:', err);
  }

  // MySQL connection retry logic
  let mysqlConnected = false;
  let retries = 10;
  while (!mysqlConnected && retries > 0) {
    try {
      const conn = await mysqlPool.getConnection();
      console.log('Connected to MySQL database!');
      conn.release();
      mysqlConnected = true;
    } catch (err) {
      console.error(`MySQL connection error (${retries} retries left):`, err);
      retries--;
      await wait(5000);
    }
  }

  // --- APIs ---

  app.get('/api/health', (req, res) => {
    const redisNodesStatus = redisStandaloneClients.map(client => ({
      host: client.nodeInfo.host,
      port: client.nodeInfo.port,
      status: client.isOpen ? 'connected' : 'disconnected'
    }));

    res.json({
      status: 'healthy',
      mysql: mysqlConnected ? 'connected' : 'disconnected',
      redis_cluster: redisClusterClient?.isOpen ? 'connected' : 'disconnected',
      redis_nodes: redisNodesStatus
    });
  });

  // MySQL CRUD APIs (unchanged from previous)

  app.get('/api/mysql/users', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users');
      res.json(rows);
    } catch (err) {
      console.error('MySQL users fetch error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.get('/api/mysql/users/:id', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('MySQL user fetch error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/mysql/users', async (req, res) => {
    const { name, email, phone, address } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const [result] = await mysqlPool.query(
        'INSERT INTO users (name, email, phone, address) VALUES (?, ?, ?, ?)',
        [name, email, phone, address]
      );
      res.status(201).json({ id: result.insertId, name, email, phone, address });
    } catch (err) {
      console.error('MySQL create user error:', err);
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.put('/api/mysql/users/:id', async (req, res) => {
    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const [result] = await mysqlPool.query(
        'UPDATE users SET name = ?, email = ?, phone = ?, address = ? WHERE id = ?',
        [name, email, phone, address, userId]
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: userId, name, email, phone, address });
    } catch (err) {
      console.error('MySQL update user error:', err);
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.delete('/api/mysql/users/:id', async (req, res) => {
    try {
      const [result] = await mysqlPool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('MySQL delete user error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Redis CRUD APIs (using redisClusterCommandWrapper)

  app.get('/api/redis/users', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const keys = await getAllKeysFromCluster('user:*');
      if (keys.length === 0) return res.json([]);

      const users = [];
      for (const key of keys) {
        try {
          const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
          if (Object.keys(userData).length > 0) {
            users.push({ id: key.split(':')[1], ...userData });
          }
        } catch (err) {
          console.error(`Redis get user error for key ${key}:`, err);
        }
      }
      res.json(users);
    } catch (err) {
      console.error('Redis fetch users error:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.get('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const userData = await redisClusterCommandWrapper(c => c.hGetAll(`user:${req.params.id}`));
      if (Object.keys(userData).length === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: req.params.id, ...userData });
    } catch (err) {
      console.error('Redis get user error:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.post('/api/redis/users', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    const { name, email, phone, address } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        try {
          const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
          if (userData.email === email) return res.status(409).json({ error: 'Email already exists' });
        } catch (err) {
          console.error(`Redis check email key ${key} error:`, err);
        }
      }

      const id = randomUUID();
      const userData = { name, email, phone: phone || '', address: address || '', created_at: new Date().toISOString() };
      await redisClusterCommandWrapper(c => c.hSet(`user:${id}`, userData));
      res.status(201).json({ id, ...userData });
    } catch (err) {
      console.error('Redis create user error:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.put('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const exists = await redisClusterCommandWrapper(c => c.exists(`user:${userId}`));
      if (!exists) return res.status(404).json({ error: 'User not found' });

      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        if (key !== `user:${userId}`) {
          try {
            const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
            if (userData.email === email) return res.status(409).json({ error: 'Email already exists' });
          } catch (err) {
            console.error(`Redis check email key ${key} error:`, err);
          }
        }
      }

      const userData = { name, email, phone: phone || '', address: address || '' };
      await redisClusterCommandWrapper(c => c.hSet(`user:${userId}`, userData));
      res.json({ id: userId, ...userData });
    } catch (err) {
      console.error('Redis update user error:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.delete('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const exists = await redisClusterCommandWrapper(c => c.exists(`user:${req.params.id}`));
      if (!exists) return res.status(404).json({ error: 'User not found' });
      await redisClusterCommandWrapper(c => c.del(`user:${req.params.id}`));
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('Redis delete user error:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  // Copy MySQL -> Redis
  app.post('/api/mysql-to-redis', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users');
      let successCount = 0;

      for (const user of rows) {
        try {
          const userData = {
            name: user.name,
            email: user.email,
            phone: user.phone || '',
            address: user.address || '',
            created_at: user.created_at.toISOString()
          };

          await redisClusterCommandWrapper(c => c.hSet(`user:${user.id}`, userData));
          successCount++;
        } catch (err) {
          console.error(`Error copying MySQL user ${user.id} to Redis:`, err);
        }
      }

      res.json({ message: `Copied ${successCount} users from MySQL to Redis`, total: rows.length, success: successCount });
    } catch (err) {
      console.error('MySQL to Redis copy error:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Copy Redis -> MySQL
  app.post('/api/redis-to-mysql', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const keys = await getAllKeysFromCluster('user:*');
      let copiedCount = 0;
      let errorCount = 0;

      for (const key of keys) {
        try {
          const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
          if (Object.keys(userData).length > 0) {
            await mysqlPool.query(
              'INSERT INTO users (name, email, phone, address) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, phone=?, address=?',
              [userData.name, userData.email, userData.phone, userData.address, userData.name, userData.phone, userData.address]
            );
            copiedCount++;
          }
        } catch (err) {
          console.error(`Error copying Redis user ${key} to MySQL:`, err);
          errorCount++;
        }
      }

      res.json({ message: `Copied ${copiedCount} users from Redis to MySQL`, total: keys.length, success: copiedCount, errors: errorCount });
    } catch (err) {
      console.error('Redis to MySQL copy error:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Cleanup duplicates in Redis
  app.post('/api/redis/cleanup-duplicates', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const keys = await getAllKeysFromCluster('user:*');
      const users = [];
      const seenEmails = new Set();
      const duplicates = [];

      for (const key of keys) {
        try {
          const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
          if (Object.keys(userData).length > 0) {
            const user = { key, id: key.split(':')[1], ...userData };
            if (seenEmails.has(userData.email)) {
              duplicates.push(user);
            } else {
              seenEmails.add(userData.email);
              users.push(user);
            }
          }
        } catch (err) {
          console.error(`Error fetching Redis user for key ${key}:`, err);
        }
      }

      let cleanedCount = 0;
      for (const dup of duplicates) {
        try {
          await redisClusterCommandWrapper(c => c.del(dup.key));
          cleanedCount++;
        } catch (err) {
          console.error(`Error deleting duplicate key ${dup.key}:`, err);
        }
      }

      let reassignedCount = 0;
      for (const user of users) {
        if (/^\d+$/.test(user.id)) {
          try {
            const newId = randomUUID();
            const newKey = `user:${newId}`;
            await redisClusterCommandWrapper(c => c.hSet(newKey, {
              name: user.name,
              email: user.email,
              phone: user.phone || '',
              address: user.address || '',
              created_at: user.created_at || new Date().toISOString()
            }));
            await redisClusterCommandWrapper(c => c.del(user.key));
            reassignedCount++;
          } catch (err) {
            console.error(`Error reassigning ID for key ${user.key}:`, err);
          }
        }
      }

      res.json({
        message: 'Cleanup completed',
        duplicatesRemoved: cleanedCount,
        idsReassigned: reassignedCount,
        totalProcessed: keys.length
      });
    } catch (err) {
      console.error('Cleanup duplicates error:', err);
      res.status(500).json({ error: 'Cleanup failed' });
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    for (const client of redisStandaloneClients) {
      if (client.isOpen) await client.quit();
    }
    console.log('Standalone Redis clients disconnected');

    if (redisClusterClient && redisClusterClient.isOpen) {
      await redisClusterClient.quit();
      console.log('Redis cluster client disconnected');
    }

    await mysqlPool.end();
    console.log('MySQL pool closed');

    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});
