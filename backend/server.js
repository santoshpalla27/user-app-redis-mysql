const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const cors = require('cors');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- Middleware --------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); // Handle preflight
app.use(express.json());

// -------------------- MySQL Connection Pool --------------------
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'mysql',
  user: process.env.MYSQL_USER || 'user',
  password: process.env.MYSQL_PASSWORD || 'password',
  database: process.env.MYSQL_DATABASE || 'userdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// -------------------- Redis Config --------------------
const redisNodes = (process.env.REDIS_NODES ||
  'redis-node-0:6379,redis-node-1:6379,redis-node-2:6379,redis-node-3:6379,redis-node-4:6379,redis-node-5:6379')
  .split(',')
  .map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port, 10) };
  });

const redisPassword = process.env.REDIS_PASSWORD || 'bitnami123';
const redisStandaloneClients = [];
let redisClusterClient = null;
let redisConnected = false;

// -------------------- Utility Functions --------------------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function disposeClusterClient() {
  try {
    if (redisClusterClient && redisClusterClient.isOpen) {
      console.log('Closing existing Redis cluster client...');
      await redisClusterClient.quit();
    }
  } catch (err) {
    console.error('Error quitting Redis cluster client:', err);
  } finally {
    redisClusterClient = null;
    redisConnected = false;
  }
}

async function createClusterClient() {
  await disposeClusterClient();
  const client = redis.createCluster({
    rootNodes: redisNodes.map(node => ({
      url: `redis://:${redisPassword}@${node.host}:${node.port}`
    })),
    defaults: { password: redisPassword }
  });

  client.on('error', err => {
    console.error('Redis Cluster Error:', err);
    redisConnected = false;
  });

  await client.connect();
  console.log('Connected to Redis Cluster, waiting 15s...');
  await wait(15000);
  redisConnected = true;
  return client;
}

async function initRedis() {
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
}

async function redisClusterCommandWrapper(commandFn, maxRetries = 5, delayMs = 3000) {
  if (!redisConnected || !redisClusterClient?.isOpen) {
    throw new Error('Redis cluster client is not connected');
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await commandFn(redisClusterClient);
    } catch (err) {
      if (
        err.message.includes("reading 'master'") ||
        err.message.includes('Slot is not served by any node') ||
        err.message.includes('CLUSTERDOWN')
      ) {
        console.warn(`Redis slot error attempt ${attempt}: ${err.message}`);
        await disposeClusterClient();
        redisClusterClient = await createClusterClient();
        await wait(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max Redis retries exceeded');
}

async function getAllKeysFromCluster(pattern) {
  if (!redisConnected || redisStandaloneClients.length === 0) return [];
  const allKeys = [];
  for (const client of redisStandaloneClients) {
    if (client.isOpen) {
      const keys = await client.keys(pattern);
      allKeys.push(...keys);
    }
  }
  return allKeys;
}

// -------------------- Routes --------------------

// Health Check
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

// (Keep all other MySQL + Redis CRUD routes same as your original — unchanged)

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);

  // Initialize Redis & MySQL in background
  (async () => {
    try {
      await initRedis();
      console.log('Redis initialized');
    } catch (err) {
      console.error('Redis initialization failed:', err);
    }

    let retries = 10;
    while (retries > 0) {
      try {
        const conn = await mysqlPool.getConnection();
        console.log('Connected to MySQL database!');
        conn.release();
        break;
      } catch (err) {
        console.error(`MySQL connection error (${retries} retries left):`, err);
        retries--;
        await wait(5000);
      }
    }
  })();
});

// -------------------- Graceful Shutdown --------------------
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    for (const client of redisStandaloneClients) {
      if (client.isOpen) await client.quit();
    }
    if (redisClusterClient?.isOpen) await redisClusterClient.quit();
    await mysqlPool.end();
    console.log('Cleanup complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});
