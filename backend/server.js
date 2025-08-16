const express = require('express');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
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

// Redis clients
let redisCluster = null;

// Utility: delay helper
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Check if Redis is ready
function isRedisReady() {
  return redisCluster && redisCluster.status === 'ready';
}

// Initialize Redis cluster with ioredis
const initRedis = async () => {
  // Don't recreate if already exists and ready
  if (redisCluster) {
    if (redisCluster.status === 'ready') {
      console.log('✅ Redis cluster already ready');
      return;
    }

    if (redisCluster.status === 'connecting') {
      console.log('Redis cluster is connecting, waiting...');
      // Wait for current connection attempt
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 15000);

        redisCluster.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });

        redisCluster.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      return;
    }

    // Cleanup existing connection
    try {
      redisCluster.removeAllListeners();
      await redisCluster.disconnect();
    } catch (err) {
      console.log('Error cleaning up existing connection:', err.message);
    }
    redisCluster = null;
  }

  console.log('Initializing new Redis cluster connection...');

  redisCluster = new Redis.Cluster(redisNodes, {
    redisOptions: {
      password: redisPassword,
      connectTimeout: 5000,
      commandTimeout: 5000,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
    },
    // Cluster-specific options
    clusterRetryDelayOnFailover: 1000,
    clusterRetryDelayOnClusterDown: 1000,
    clusterMaxRedirections: 16,
    slotsRefreshTimeout: 5000,
    slotsRefreshInterval: 5000,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
  });

  // Set up event handlers
  redisCluster.on('error', (err) => {
    console.error('Redis Cluster Error:', err.message);
  });

  redisCluster.on('connect', () => {
    console.log('✅ Redis cluster connected');
  });

  redisCluster.on('ready', () => {
    console.log('✅ Redis cluster ready');
  });

  redisCluster.on('close', () => {
    console.log('Redis cluster connection closed');
  });

  redisCluster.on('reconnecting', (delayTime) => {
    console.log(`Redis cluster reconnecting in ${delayTime || 'unknown'}ms...`);
  });

  redisCluster.on('end', () => {
    console.log('Redis cluster connection ended');
  });

  // Wait for cluster to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Redis cluster connection timeout'));
    }, 15000);

    if (redisCluster.status === 'ready') {
      clearTimeout(timeout);
      resolve();
      return;
    }

    redisCluster.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });

    redisCluster.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Test the connection
  try {
    await redisCluster.ping();
    console.log('✅ Redis cluster ping successful - initialization complete');
  } catch (err) {
    throw new Error(`Redis cluster ping failed: ${err.message}`);
  }
};

// Helper: scan keys across cluster with proper error handling
async function getAllKeysFromCluster(pattern) {
  if (!isRedisReady()) {
    console.log('Redis not ready, returning empty array');
    return [];
  }

  try {
    // Get all masters in the cluster
    const masters = redisCluster.nodes('master');
    const allKeys = new Set(); // Use Set to avoid duplicates

    // Scan each master node
    for (const master of masters) {
      if (master.status !== 'ready') continue;

      try {
        let cursor = '0';
        do {
          const result = await master.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = result[0];
          const keys = result[1];
          keys.forEach(key => allKeys.add(key));
        } while (cursor !== '0');
      } catch (err) {
        console.error(`Error scanning keys from master ${master.options.host}:${master.options.port}:`, err.message);
      }
    }

    return Array.from(allKeys);
  } catch (err) {
    console.error('Error scanning Redis keys:', err.message);
    return [];
  }
}

// Simple Redis command wrapper with better error handling
async function executeRedisCommand(commandFn, maxRetries = 3) {
  if (!isRedisReady()) {
    throw new Error('Redis cluster is not ready');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await commandFn(redisCluster);
    } catch (err) {
      console.error(`Redis command attempt ${attempt} failed:`, err.message);

      if (attempt === maxRetries) {
        throw err;
      }

      // Wait before retry
      await wait(500 * attempt);
    }
  }
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Initialize Redis with single attempt and better error handling
  try {
    await initRedis();
  } catch (err) {
    console.error('Redis initialization failed:', err.message);
    console.log('Server will continue without Redis functionality');
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
    let clusterNodes = [];
    let redisStatus = 'disconnected';

    if (redisCluster) {
      try {
        redisStatus = redisCluster.status;
        const allNodes = redisCluster.nodes('all');
        clusterNodes = allNodes.map(node => ({
          host: node.options.host,
          port: node.options.port,
          status: node.status || 'unknown'
        }));
      } catch (err) {
        console.error('Error getting cluster nodes:', err.message);
      }
    }

    res.json({
      status: 'healthy',
      mysql: mysqlConnected ? 'connected' : 'disconnected',
      redis_cluster: isRedisReady() ? 'ready' : redisStatus,
      redis_nodes: clusterNodes
    });
  });

  // MySQL CRUD APIs (unchanged)

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

  // Redis CRUD APIs

  app.get('/api/redis/users', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      const keys = await getAllKeysFromCluster('user:*');
      if (keys.length === 0) return res.json([]);

      const users = [];
      for (const key of keys) {
        try {
          const userData = await executeRedisCommand(client => client.hgetall(key));
          if (Object.keys(userData).length > 0) {
            users.push({ id: key.split(':')[1], ...userData });
          }
        } catch (err) {
          console.error(`Redis get user error for key ${key}:`, err.message);
        }
      }
      res.json(users);
    } catch (err) {
      console.error('Redis fetch users error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.get('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      const userData = await executeRedisCommand(client => client.hgetall(`user:${req.params.id}`));
      if (Object.keys(userData).length === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: req.params.id, ...userData });
    } catch (err) {
      console.error('Redis get user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.post('/api/redis/users', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    const { name, email, phone, address } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      // Check for duplicate email
      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        try {
          const userData = await executeRedisCommand(client => client.hgetall(key));
          if (userData.email === email) {
            return res.status(409).json({ error: 'Email already exists' });
          }
        } catch (err) {
          console.error(`Redis check email key ${key} error:`, err.message);
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

      await executeRedisCommand(client => client.hset(`user:${id}`, userData));
      res.status(201).json({ id, ...userData });
    } catch (err) {
      console.error('Redis create user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.put('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    const { name, email, phone, address } = req.body;
    const userId = req.params.id;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    try {
      const exists = await executeRedisCommand(client => client.exists(`user:${userId}`));
      if (!exists) return res.status(404).json({ error: 'User not found' });

      // Check for duplicate email (excluding current user)
      const keys = await getAllKeysFromCluster('user:*');
      for (const key of keys) {
        if (key !== `user:${userId}`) {
          try {
            const userData = await executeRedisCommand(client => client.hgetall(key));
            if (userData.email === email) {
              return res.status(409).json({ error: 'Email already exists' });
            }
          } catch (err) {
            console.error(`Redis check email key ${key} error:`, err.message);
          }
        }
      }

      const userData = { name, email, phone: phone || '', address: address || '' };
      await executeRedisCommand(client => client.hset(`user:${userId}`, userData));
      res.json({ id: userId, ...userData });
    } catch (err) {
      console.error('Redis update user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.delete('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      const exists = await executeRedisCommand(client => client.exists(`user:${req.params.id}`));
      if (!exists) return res.status(404).json({ error: 'User not found' });

      await executeRedisCommand(client => client.del(`user:${req.params.id}`));
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('Redis delete user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  // Copy MySQL -> Redis
  app.post('/api/mysql-to-redis', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

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

          await executeRedisCommand(client => client.hset(`user:${user.id}`, userData));
          successCount++;
        } catch (err) {
          console.error(`Error copying MySQL user ${user.id} to Redis:`, err.message);
        }
      }

      res.json({
        message: `Copied ${successCount} users from MySQL to Redis`,
        total: rows.length,
        success: successCount
      });
    } catch (err) {
      console.error('MySQL to Redis copy error:', err);
      res.status(500).json({ error: 'Operation failed: ' + err.message });
    }
  });

  // Copy Redis -> MySQL
  app.post('/api/redis-to-mysql', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      const keys = await getAllKeysFromCluster('user:*');
      let copiedCount = 0;
      let errorCount = 0;

      for (const key of keys) {
        try {
          const userData = await executeRedisCommand(client => client.hgetall(key));
          if (Object.keys(userData).length > 0) {
            await mysqlPool.query(
              'INSERT INTO users (name, email, phone, address) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, phone=?, address=?',
              [userData.name, userData.email, userData.phone, userData.address, userData.name, userData.phone, userData.address]
            );
            copiedCount++;
          }
        } catch (err) {
          console.error(`Error copying Redis user ${key} to MySQL:`, err.message);
          errorCount++;
        }
      }

      res.json({
        message: `Copied ${copiedCount} users from Redis to MySQL`,
        total: keys.length,
        success: copiedCount,
        errors: errorCount
      });
    } catch (err) {
      console.error('Redis to MySQL copy error:', err);
      res.status(500).json({ error: 'Operation failed: ' + err.message });
    }
  });

  // Cleanup duplicates in Redis
  app.post('/api/redis/cleanup-duplicates', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      const keys = await getAllKeysFromCluster('user:*');
      const users = [];
      const seenEmails = new Set();
      const duplicates = [];

      // Find duplicates
      for (const key of keys) {
        try {
          const userData = await executeRedisCommand(client => client.hgetall(key));
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
          console.error(`Error fetching Redis user for key ${key}:`, err.message);
        }
      }

      // Remove duplicates
      let cleanedCount = 0;
      for (const dup of duplicates) {
        try {
          await executeRedisCommand(client => client.del(dup.key));
          cleanedCount++;
        } catch (err) {
          console.error(`Error deleting duplicate key ${dup.key}:`, err.message);
        }
      }

      // Reassign numeric IDs to UUIDs
      let reassignedCount = 0;
      for (const user of users) {
        if (/^\d+$/.test(user.id)) {
          try {
            const newId = randomUUID();
            const newKey = `user:${newId}`;
            const userData = {
              name: user.name,
              email: user.email,
              phone: user.phone || '',
              address: user.address || '',
              created_at: user.created_at || new Date().toISOString()
            };

            await executeRedisCommand(client => client.hset(newKey, userData));
            await executeRedisCommand(client => client.del(user.key));
            reassignedCount++;
          } catch (err) {
            console.error(`Error reassigning ID for key ${user.key}:`, err.message);
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
      res.status(500).json({ error: 'Cleanup failed: ' + err.message });
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    if (redisCluster) {
      redisCluster.removeAllListeners();
      await redisCluster.disconnect();
      console.log('Redis cluster disconnected');
    }

    await mysqlPool.end();
    console.log('MySQL pool closed');

    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});
