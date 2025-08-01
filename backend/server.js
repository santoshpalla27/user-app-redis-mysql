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
app.use(cors({
  origin: true,
  credentials: true
}));
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

// Parse Redis nodes from env
const redisNodes = (process.env.REDIS_NODES ||
  'redis-node-0:6379,redis-node-1:6379,redis-node-2:6379,redis-node-3:6379,redis-node-4:6379,redis-node-5:6379')
  .split(',')
  .map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port, 10) };
  });

const redisPassword = process.env.REDIS_PASSWORD || 'bitnami123';

// Standalone Redis clients (per node, for keys scanning)
const redisStandaloneClients = [];

let redisClusterClient = null;
let redisConnected = false;

// Helper wait/delay
const wait = ms => new Promise(res => setTimeout(res, ms));

// Dispose current cluster client properly
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

// Initialize Redis Cluster client with retries
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

  // Delay to allow cluster topology stabilization
  console.log('Connected to Redis Cluster, waiting 15 seconds for cluster topology stabilization...');
  await wait(15000);

  redisConnected = true;
  console.log('✅ Redis cluster ready');

  return client;
}

// Initialize Redis clients (standalone + cluster)
const initRedis = async () => {
  // Connect standalone clients if not yet
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

// Redis cluster command wrapper with reconnect + retries on slot cache errors
async function redisClusterCommandWrapper(commandFn, maxRetries = 5, delayMs = 3000) {
  if (!redisConnected || !redisClusterClient || !redisClusterClient.isOpen) {
    throw new Error('Redis cluster client is not connected');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Diagnostic logging before command
      console.log(`Redis cluster command attempt ${attempt} - slots cache size:`, redisClusterClient.slots?.size);
      return await commandFn(redisClusterClient);
    } catch (err) {
      // Known slot cache routing errors leading to 'master' undefined
      if (
        err.message.includes("Cannot read properties of undefined (reading 'master')") ||
        err.message.includes('Slot is not served by any node') ||
        err.message.includes('CLUSTERDOWN')
      ) {
        console.warn(`Redis cluster slot error on attempt ${attempt}: ${err.message}`);
        // Try reconnecting cluster client to refresh all cache/state
        try {
          console.log('Attempting to reconnect Redis cluster client to refresh slot cache...');
          await disposeClusterClient();
          redisClusterClient = await createClusterClient();
          await wait(delayMs);
        } catch (reconnectErr) {
          console.error('Error reconnecting Redis cluster client:', reconnectErr);
          // If reconnect failed, throw or delay and retry
          if (attempt === maxRetries) throw reconnectErr;
          await wait(delayMs);
        }
        continue; // retry command
      }
      // For other errors, re-throw immediately
      throw err;
    }
  }

  throw new Error('Max Redis cluster retries exceeded');
}

// Helper to scan keys across standalone clients
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

  // MySQL connection retries
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

  // --- API endpoints (MySQL, Redis) ---

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

  // MySQL CRUD (same as before)...

  app.get('/api/mysql/users', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users');
      res.json(rows);
    } catch (e) {
      console.error('MySQL fetch error:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.get('/api/mysql/users/:id', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users WHERE id=?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (e) {
      console.error('MySQL fetch user error:', e);
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
    } catch (e) {
      console.error('MySQL create user error:', e);
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.put('/api/mysql/users/:id', async (req, res) => {
    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const [result] = await mysqlPool.query(
        'UPDATE users SET name=?, email=?, phone=?, address=? WHERE id=?',
        [name, email, phone, address, userId]
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: userId, name, email, phone, address });
    } catch (e) {
      console.error('MySQL update user error:', e);
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.delete('/api/mysql/users/:id', async (req, res) => {
    try {
      const [result] = await mysqlPool.query('DELETE FROM users WHERE id=?', [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User deleted successfully' });
    } catch (e) {
      console.error('MySQL delete user error:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Redis CRUD (wrapped with redisClusterCommandWrapper)...

  app.get('/api/redis/users', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const keys = await getAllKeysFromCluster('user:*');
      if (keys.length === 0) return res.json([]);

      const users = [];
      for (const key of keys) {
        try {
          const userData = await redisClusterCommandWrapper(c => c.hGetAll(key));
          if (Object.keys(userData).length > 0) users.push({ id: key.split(':')[1], ...userData });
        } catch (e) {
          console.error(`Redis get user error key ${key}:`, e);
        }
      }
      res.json(users);
    } catch (e) {
      console.error('Redis fetch users error:', e);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.get('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) return res.status(503).json({ error: 'Redis not connected' });
    try {
      const userData = await redisClusterCommandWrapper(c => c.hGetAll(`user:${req.params.id}`));
      if (Object.keys(userData).length === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: req.params.id, ...userData });
    } catch (e) {
      console.error('Redis fetch user error:', e);
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
        } catch (e) {
          console.error(`Redis check email key ${key} error:`, e);
        }
      }

      const id = randomUUID();
      const userData = {
        name,
        email,
        phone: phone || '',
        address: address || '',
        created_at: new Date().toISOString()
      };

      await redisClusterCommandWrapper(c => c.hSet(`user:${id}`, userData));
      res.status(201).json({ id, ...userData });
    } catch (e) {
      console.error('Redis create user error:', e);
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
          } catch (e) {
            console.error(`Redis check email key ${key} error:`, e);
          }
        }
      }

      const userData = { name, email, phone: phone || '', address: address || '' };
      await redisClusterCommandWrapper(c => c.hSet(`user:${userId}`, userData));
      res.json({ id: userId, ...userData });
    } catch (e) {
      console.error('Redis update user error:', e);
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
    } catch (e) {
      console.error('Redis delete user error:', e);
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
        } catch (e) {
          console.error(`Error copying MySQL user ${user.id} to Redis:`, e);
        }
      }
      res.json({ message: `Copied ${successCount} users from MySQL to Redis`, total: rows.length, success: successCount });
    } catch (e) {
      console.error('MySQL to Redis copy error:', e);
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
        } catch (e) {
          console.error(`Error copying Redis user ${key} to MySQL:`, e);
          errorCount++;
        }
      }
      res.json({ message: `Copied ${copiedCount} users from Redis to MySQL`, total: keys.length, success: copiedCount, errors: errorCount });
    } catch (e) {
      console.error('Redis to MySQL copy error:', e);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Cleanup duplicate users in Redis
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
        } catch (e) {
          console.error(`Error fetching Redis user for key ${key}:`, e);
        }
      }

      let cleanedCount = 0;
      for (const dup of duplicates) {
        try {
          await redisClusterCommandWrapper(c => c.del(dup.key));
          cleanedCount++;
        } catch (e) {
          console.error(`Error deleting duplicate key ${dup.key}:`, e);
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
          } catch (e) {
            console.error(`Error reassigning ID for key ${user.key}:`, e);
          }
        }
      }

      res.json({
        message: 'Cleanup completed',
        duplicatesRemoved: cleanedCount,
        idsReassigned: reassignedCount,
        totalProcessed: keys.length
      });
    } catch (e) {
      console.error('Cleanup duplicates error:', e);
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
  } catch (e) {
    console.error('Error during shutdown:', e);
    process.exit(1);
  }
});
