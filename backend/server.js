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
  origin: true, // Allow any origin
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

// Parse Redis nodes from environment
const redisNodes = (process.env.REDIS_NODES || 'redis-node-0:6379,redis-node-1:6379,redis-node-2:6379,redis-node-3:6379,redis-node-4:6379,redis-node-5:6379')
  .split(',')
  .map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port, 10) };
  });

// Redis password
const redisPassword = process.env.REDIS_PASSWORD || 'bitnami123';

// Create an array to store standalone Redis clients for each node
const redisStandaloneClients = [];
let redisClusterClient = null;

// Flag to track Redis cluster connection status
let redisConnected = false;

// Initialize Redis connections with robust retry and slot cache validation
const initRedis = async () => {
  if (redisConnected) return;

  try {
    // Connect standalone Redis clients to each node (used to scan keys)
    for (const node of redisNodes) {
      const client = redis.createClient({
        url: `redis://:${redisPassword}@${node.host}:${node.port}`
      });
      client.on('error', (err) => {
        console.error(`Redis node ${node.host}:${node.port} error:`, err);
      });
      await client.connect();
      console.log(`Connected to Redis node ${node.host}:${node.port}`);
      client.nodeInfo = node;
      redisStandaloneClients.push(client);
    }

    let retries = 10;

    while (retries > 0) {
      try {
        if (redisClusterClient) {
          await redisClusterClient.quit();
          redisClusterClient = null;
        }

        redisClusterClient = redis.createCluster({
          rootNodes: redisNodes.map(node => ({
            url: `redis://:${redisPassword}@${node.host}:${node.port}`
          })),
          defaults: {
            password: redisPassword
          }
        });

        redisClusterClient.on('error', (err) => {
          console.error('❌ Redis Cluster Error:', err);
        });

        await redisClusterClient.connect();

        // Try to get cluster nodes info for debugging
        try {
          const nodesInfo = await redisClusterClient.clusterNodes();
          console.log('Cluster nodes info:', nodesInfo);
        } catch (err) {
          console.warn('Failed to get cluster nodes info:', err.message);
        }

        // Refresh slots cache and check if slot cache is populated
        if (typeof redisClusterClient.refreshSlotsCache === 'function') {
          await redisClusterClient.refreshSlotsCache();
          console.log('✅ Redis slot cache refreshed.');
        } else {
          console.warn('refreshSlotsCache method not found on redisClusterClient');
        }

        if (!redisClusterClient.slots || redisClusterClient.slots.size === 0) {
          throw new Error('Slots cache empty after refresh');
        } else {
          console.log('Slots cache contains entries:', redisClusterClient.slots.size);
        }

        // Dummy GET to warm up cluster slots mapping
        try {
          await redisClusterClient.get('dummy_key');
        } catch (err) {
          console.warn('Initial dummy GET failed (likely key does not exist, which is okay):', err.message);
        }

        // Wait extra time to ensure cluster client stability
        await new Promise((resolve) => setTimeout(resolve, 6000));

        redisConnected = true;
        console.log('✅ Connected to Redis Cluster and ready!');
        break;
      } catch (err) {
        console.error(`⚠️ Retry Redis Cluster Connect (${retries} retries left):`, err.message);
        retries--;
        if (redisClusterClient) {
          try {
            await redisClusterClient.quit();
          } catch {}
          redisClusterClient = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }
    }

    if (!redisConnected) {
      console.error('❌ Could not initialize Redis Cluster after retries.');
    }
  } catch (err) {
    console.error('❌ Redis connection initialization error:', err);
  }
};

// Function to get all keys matching pattern across all standalone Redis nodes
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

  await initRedis();

  // MySQL connection with retries
  let mysqlConnected = false;
  let retries = 10;
  while (!mysqlConnected && retries > 0) {
    try {
      const conn = await mysqlPool.getConnection();
      console.log('Connected to MySQL database!');
      conn.release();
      mysqlConnected = true;
    } catch (err) {
      console.error(`Error connecting to MySQL (${retries} retries left):`, err);
      retries--;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Health endpoint
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

  // MySQL CRUD routes

  app.get('/api/mysql/users', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users');
      res.json(rows);
    } catch (err) {
      console.error('Error fetching users from MySQL:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.get('/api/mysql/users/:id', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(rows[0]);
    } catch (err) {
      console.error('Error fetching user from MySQL:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/mysql/users', async (req, res) => {
    const { name, email, phone, address } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    try {
      const [result] = await mysqlPool.query(
        'INSERT INTO users (name, email, phone, address) VALUES (?, ?, ?, ?)',
        [name, email, phone, address]
      );
      res.status(201).json({
        id: result.insertId,
        name,
        email,
        phone,
        address
      });
    } catch (err) {
      console.error('Error creating user in MySQL:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email already exists' });
      }
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.put('/api/mysql/users/:id', async (req, res) => {
    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    try {
      const [result] = await mysqlPool.query(
        'UPDATE users SET name = ?, email = ?, phone = ?, address = ? WHERE id = ?',
        [name, email, phone, address, userId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({
        id: userId,
        name,
        email,
        phone,
        address
      });
    } catch (err) {
      console.error('Error updating user in MySQL:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email already exists' });
      }
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.delete('/api/mysql/users/:id', async (req, res) => {
    try {
      const [result] = await mysqlPool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('Error deleting user from MySQL:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Redis CRUD routes

  app.get('/api/redis/users', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    try {
      const keys = await getAllKeysFromCluster('user:*');
      if (keys.length === 0) return res.json([]);

      const users = [];
      for (const key of keys) {
        try {
          const userData = await redisClusterClient.hGetAll(key);
          if (Object.keys(userData).length > 0) {
            users.push({ id: key.split(':')[1], ...userData });
          }
        } catch (err) {
          console.error(`Error fetching data for key ${key}:`, err);
        }
      }
      res.json(users);
    } catch (err) {
      console.error('Error fetching users from Redis:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.get('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    try {
      const userData = await redisClusterClient.hGetAll(`user:${req.params.id}`);
      if (Object.keys(userData).length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ id: req.params.id, ...userData });
    } catch (err) {
      console.error('Error fetching user from Redis:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.post('/api/redis/users', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    const { name, email, phone, address } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    try {
      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        try {
          const userData = await redisClusterClient.hGetAll(key);
          if (userData.email === email) {
            return res.status(409).json({ error: 'Email already exists' });
          }
        } catch (err) {
          console.error(`Error checking email for key ${key}:`, err);
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
      await redisClusterClient.hSet(`user:${id}`, userData);
      res.status(201).json({ id, ...userData });
    } catch (err) {
      console.error('Error creating user in Redis:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.put('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    try {
      const exists = await redisClusterClient.exists(`user:${userId}`);
      if (!exists) {
        return res.status(404).json({ error: 'User not found' });
      }
      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        if (key !== `user:${userId}`) {
          try {
            const userData = await redisClusterClient.hGetAll(key);
            if (userData.email === email) {
              return res.status(409).json({ error: 'Email already exists' });
            }
          } catch (err) {
            console.error(`Error checking email for key ${key}:`, err);
          }
        }
      }
      const userData = {
        name,
        email,
        phone: phone || '',
        address: address || ''
      };
      await redisClusterClient.hSet(`user:${userId}`, userData);
      res.json({ id: userId, ...userData });
    } catch (err) {
      console.error('Error updating user in Redis:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  app.delete('/api/redis/users/:id', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    try {
      const exists = await redisClusterClient.exists(`user:${req.params.id}`);
      if (!exists) {
        return res.status(404).json({ error: 'User not found' });
      }
      await redisClusterClient.del(`user:${req.params.id}`);
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('Error deleting user from Redis:', err);
      res.status(500).json({ error: 'Redis error' });
    }
  });

  // Copy users MySQL -> Redis
  app.post('/api/mysql-to-redis', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
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
          await redisClusterClient.hSet(`user:${user.id}`, userData);
          successCount++;
        } catch (err) {
          console.error(`Error copying user ${user.id} to Redis:`, err);
        }
      }
      res.json({ message: `Copied ${successCount} users from MySQL to Redis`, total: rows.length, success: successCount });
    } catch (err) {
      console.error('Error copying users from MySQL to Redis:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Copy users Redis -> MySQL
  app.post('/api/redis-to-mysql', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    try {
      const keys = await getAllKeysFromCluster('user:*');
      let copiedCount = 0;
      let errorCount = 0;
      for (const key of keys) {
        try {
          const userData = await redisClusterClient.hGetAll(key);
          if (Object.keys(userData).length > 0) {
            await mysqlPool.query(
              'INSERT INTO users (name, email, phone, address) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, phone=?, address=?',
              [userData.name, userData.email, userData.phone, userData.address, userData.name, userData.phone, userData.address]
            );
            copiedCount++;
          }
        } catch (err) {
          console.error(`Error inserting user ${key} to MySQL:`, err);
          errorCount++;
        }
      }
      res.json({ message: `Copied ${copiedCount} users from Redis to MySQL`, total: keys.length, success: copiedCount, errors: errorCount });
    } catch (err) {
      console.error('Error copying users from Redis to MySQL:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Cleanup duplicate users in Redis endpoint
  app.post('/api/redis/cleanup-duplicates', async (req, res) => {
    if (!redisConnected) {
      return res.status(503).json({ error: 'Redis connection not available' });
    }
    try {
      const keys = await getAllKeysFromCluster('user:*');
      const users = [];
      const seenEmails = new Set();
      const duplicates = [];

      for (const key of keys) {
        try {
          const userData = await redisClusterClient.hGetAll(key);
          if (Object.keys(userData).length > 0) {
            const user = {
              key,
              id: key.split(':')[1],
              ...userData
            };
            if (seenEmails.has(userData.email)) {
              duplicates.push(user);
            } else {
              seenEmails.add(userData.email);
              users.push(user);
            }
          }
        } catch (err) {
          console.error(`Error fetching data for key ${key}:`, err);
        }
      }

      // Delete duplicate keys
      let cleanedCount = 0;
      for (const duplicate of duplicates) {
        try {
          await redisClusterClient.del(duplicate.key);
          cleanedCount++;
        } catch (err) {
          console.error(`Error deleting duplicate ${duplicate.key}:`, err);
        }
      }

      // Reassign IDs to users with timestamp-like IDs (all digits)
      let reassignedCount = 0;
      for (const user of users) {
        if (/^\d+$/.test(user.id)) {
          try {
            const newId = randomUUID();
            const newKey = `user:${newId}`;
            await redisClusterClient.hSet(newKey, {
              name: user.name,
              email: user.email,
              phone: user.phone || '',
              address: user.address || '',
              created_at: user.created_at || new Date().toISOString()
            });
            await redisClusterClient.del(user.key);
            reassignedCount++;
          } catch (err) {
            console.error(`Error reassigning ID for ${user.key}:`, err);
          }
        }
      }

      res.json({ message: 'Cleanup completed', duplicatesRemoved: cleanedCount, idsReassigned: reassignedCount, totalProcessed: keys.length });
    } catch (err) {
      console.error('Error during cleanup:', err);
      res.status(500).json({ error: 'Cleanup failed' });
    }
  });

});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    // Quit standalone Redis clients
    if (redisStandaloneClients.length > 0) {
      for (const client of redisStandaloneClients) {
        if (client.isOpen) {
          await client.quit();
        }
      }
      console.log('Redis standalone clients disconnected');
    }

    // Quit Redis cluster client
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
