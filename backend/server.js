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

// MySQL Connection Pool with RDS configuration
const mysqlPool = mysql.createPool({
  host: process.env.RDS_ENDPOINT || 'localhost',
  user: process.env.RDS_MASTER_USERNAME || 'admin',
  password: process.env.RDS_MASTER_PASSWORD || 'password',
  database: process.env.RDS_DATABASE || 'userdb',
  port: process.env.RDS_PORT || 3306,
  ssl: process.env.RDS_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// AWS ElastiCache Redis Cluster Configuration
const redisClusterEndpoint = process.env.REDIS_CLUSTER_ENDPOINT || 'clustercfg.redis.anp3iz.use1.cache.amazonaws.com';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD; // Optional for ElastiCache
const redisUseTLS = process.env.REDIS_USE_TLS === 'true';

// Redis clients
let redisCluster = null;
let isRedisOperational = false;

// Utility: delay helper
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Check if Redis is ready and operational
function isRedisReady() {
  return redisCluster && redisCluster.status === 'ready' && isRedisOperational;
}

// Test Redis operations to ensure it's fully functional
async function testRedisOperations() {
  if (!redisCluster || redisCluster.status !== 'ready') {
    throw new Error('Redis cluster not ready');
  }

  const testKeys = [];
  
  try {
    console.log('🔍 Testing Redis operations...');
    
    // Test 1: Basic ping
    const pingResult = await redisCluster.ping();
    console.log('✅ Ping test passed:', pingResult);
    
    // Test 2: Set and get operation
    const testKey = 'test:connection:' + Date.now();
    const testValue = 'connection-test-' + randomUUID();
    testKeys.push(testKey);
    
    await redisCluster.set(testKey, testValue, 'EX', 30); // Expire in 30 seconds
    const retrievedValue = await redisCluster.get(testKey);
    
    if (retrievedValue !== testValue) {
      throw new Error('Set/Get test failed - values do not match');
    }
    console.log('✅ Set/Get test passed');
    
    // Test 3: Hash operations (used by your user APIs)
    const testHashKey = 'test:hash:' + Date.now();
    const testHashData = {
      name: 'Test User',
      email: 'test@example.com',
      phone: '1234567890'
    };
    testKeys.push(testHashKey);
    
    await redisCluster.hset(testHashKey, testHashData);
    const retrievedHash = await redisCluster.hgetall(testHashKey);
    
    if (JSON.stringify(retrievedHash) !== JSON.stringify(testHashData)) {
      throw new Error('Hash operations test failed');
    }
    console.log('✅ Hash operations test passed');
    
    // Test 4: Key scanning (used by getAllKeysFromCluster)
    const masters = redisCluster.nodes('master');
    if (masters.length === 0) {
      throw new Error('No master nodes available');
    }
    
    // Test scanning on first master
    const firstMaster = masters[0];
    const scanResult = await firstMaster.scan('0', 'MATCH', 'test:*', 'COUNT', 10);
    console.log('✅ Key scanning test passed');
    
    // Test 5: Cluster info
    const clusterInfo = await redisCluster.cluster('INFO');
    if (!clusterInfo.includes('cluster_state:ok')) {
      throw new Error('Cluster state is not OK');
    }
    console.log('✅ Cluster info test passed');
    
    // Test 6: User-like operations that your app will actually do
    const userTestKey = `user:test-${randomUUID()}`;
    const userTestData = {
      name: 'Test User',
      email: 'test-user@example.com',
      phone: '9876543210',
      address: 'Test Address',
      created_at: new Date().toISOString()
    };
    testKeys.push(userTestKey);
    
    // Test HSET, EXISTS, HGETALL operations like your APIs use
    await redisCluster.hset(userTestKey, userTestData);
    const exists = await redisCluster.exists(userTestKey);
    if (!exists) {
      throw new Error('User key existence test failed');
    }
    
    const retrievedUserData = await redisCluster.hgetall(userTestKey);
    if (retrievedUserData.email !== userTestData.email) {
      throw new Error('User data retrieval test failed');
    }
    console.log('✅ User operations test passed');
    
    // Cleanup test data - delete keys individually to avoid CROSSSLOT issues
    console.log('🧹 Cleaning up test data...');
    for (const key of testKeys) {
      try {
        await redisCluster.del(key);
      } catch (err) {
        console.log(`Warning: Could not delete test key ${key}:`, err.message);
        // Not a critical error, test keys have expiration anyway
      }
    }
    console.log('✅ Test cleanup completed');
    
    console.log('🎉 All Redis operation tests passed - Redis is fully operational');
    return true;
    
  } catch (err) {
    console.error('❌ Redis operation test failed:', err.message);
    
    // Best effort cleanup on failure
    if (testKeys.length > 0) {
      console.log('🧹 Attempting cleanup after test failure...');
      for (const key of testKeys) {
        try {
          await redisCluster.del(key);
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
      }
    }
    
    throw err;
  }
}

// AWS ElastiCache Redis Cluster initialization
const initRedis = async (maxAttempts = 3) => {
  console.log('🚀 Initializing AWS ElastiCache Redis Cluster...');
  console.log(`📍 Cluster endpoint: ${redisClusterEndpoint}:${redisPort}`);
  console.log(`🔒 TLS enabled: ${redisUseTLS}`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🚀 Redis cluster connection attempt ${attempt}/${maxAttempts}`);
    
    try {
      // Clean up existing connection if any
      if (redisCluster) {
        try {
          redisCluster.removeAllListeners();
          await redisCluster.disconnect();
        } catch (err) {
          console.log('Cleanup warning:', err.message);
        }
        redisCluster = null;
        isRedisOperational = false;
      }

      console.log('Creating new AWS ElastiCache Redis cluster connection...');

      // Build Redis options
      const redisOptions = {
        connectTimeout: 10000,
        commandTimeout: 8000,
        retryDelayOnFailover: 1000,
        maxRetriesPerRequest: 3,
        lazyConnect: false,
        keepAlive: 30000,
        family: 4,
        enableOfflineQueue: true,
      };

      // Add password if provided (skip if empty to avoid warning)
      if (redisPassword && redisPassword.trim() !== '') {
        redisOptions.password = redisPassword;
        console.log('🔐 Using Redis password authentication');
      } else {
        console.log('🔓 No Redis password provided - using passwordless connection');
      }

      // Add TLS configuration if enabled
      if (redisUseTLS) {
        redisOptions.tls = {};
      }

      // Create cluster connection with AWS-specific configuration
      redisCluster = new Redis.Cluster(
        [{ host: redisClusterEndpoint, port: redisPort }],
        {
          dnsLookup: (address, callback) => callback(null, address),
          redisOptions: redisOptions,
          // Cluster-specific options
          clusterRetryDelayOnFailover: 1000,
          clusterRetryDelayOnClusterDown: 2000,
          clusterMaxRedirections: 16,
          slotsRefreshTimeout: 10000,
          slotsRefreshInterval: 30000,
          enableReadyCheck: true,
          maxRetriesPerRequest: 3,
          scaleReads: 'master',
        }
      );

      let readyPromiseResolve, readyPromiseReject;
      let connectionStable = false;

      // Set up event handlers
      redisCluster.on('error', (err) => {
        console.error('❌ Redis Cluster Error:', err.message);
        isRedisOperational = false;
        if (readyPromiseReject && !connectionStable) readyPromiseReject(err);
      });

      redisCluster.on('connect', () => {
        console.log('🔗 Redis cluster connected');
      });

      redisCluster.on('ready', () => {
        console.log('✅ Redis cluster ready');
      });

      redisCluster.on('close', () => {
        console.log('🔌 Redis cluster connection closed');
        isRedisOperational = false;
        connectionStable = false;
      });

      redisCluster.on('reconnecting', (delayTime) => {
        console.log(`🔄 Redis cluster reconnecting in ${delayTime || 'unknown'}ms...`);
        isRedisOperational = false;
        connectionStable = false;
      });

      redisCluster.on('end', () => {
        console.log('🔚 Redis cluster connection ended');
        isRedisOperational = false;
        connectionStable = false;
      });

      redisCluster.on('node error', (err, node) => {
        console.error(`❌ Redis node error ${node.options.host}:${node.options.port}:`, err.message);
      });

      // Wait for cluster to be ready and stable
      await new Promise((resolve, reject) => {
        readyPromiseResolve = resolve;
        readyPromiseReject = reject;
        
        const timeout = setTimeout(() => {
          reject(new Error('Redis cluster connection timeout after 30 seconds'));
        }, 30000);

        let stabilityCheckCount = 0;
        const maxStabilityChecks = 3;
        
        const checkStability = () => {
          if (redisCluster.status === 'ready') {
            stabilityCheckCount++;
            console.log(`✅ Connection stability check ${stabilityCheckCount}/${maxStabilityChecks} passed`);
            
            if (stabilityCheckCount >= maxStabilityChecks) {
              connectionStable = true;
              clearTimeout(timeout);
              resolve();
            } else {
              setTimeout(checkStability, 2000);
            }
          } else {
            console.log(`⏳ Waiting for ready status, current: ${redisCluster.status}`);
            stabilityCheckCount = 0;
            setTimeout(checkStability, 1000);
          }
        };

        // Start checking when ready
        redisCluster.once('ready', () => {
          console.log('🔍 Starting connection stability checks...');
          setTimeout(checkStability, 1000);
        });

        if (redisCluster.status === 'ready') {
          console.log('🔍 Starting connection stability checks (already ready)...');
          setTimeout(checkStability, 1000);
        }
      });

      console.log('✅ Redis cluster connection appears stable, testing operations...');

      // Test operations thoroughly
      await testRedisOperations();
      
      isRedisOperational = true;
      console.log('🎉 AWS ElastiCache Redis cluster initialization completed successfully');
      return;

    } catch (err) {
      console.error(`❌ Redis connection attempt ${attempt} failed:`, err.message);
      
      if (redisCluster) {
        try {
          redisCluster.removeAllListeners();
          await redisCluster.disconnect();
        } catch (cleanupErr) {
          console.log('Cleanup error:', cleanupErr.message);
        }
        redisCluster = null;
      }
      
      isRedisOperational = false;

      if (attempt === maxAttempts) {
        throw new Error(`AWS ElastiCache Redis connection failed after ${maxAttempts} attempts: ${err.message}`);
      }

      const delay = attempt * 3000;
      console.log(`⏳ Waiting ${delay}ms before next connection attempt...`);
      await wait(delay);
    }
  }
};

// Improved helper: scan keys across cluster
async function getAllKeysFromCluster(pattern) {
  if (!isRedisReady()) {
    console.log('Redis not ready, returning empty array');
    return [];
  }

  try {
    const allKeys = new Set();
    
    // Get all master nodes from the cluster
    const masters = redisCluster.nodes('master');
    console.log(`Scanning ${masters.length} master nodes for pattern: ${pattern}`);

    for (const master of masters) {
      if (master.status !== 'ready') {
        console.log(`Skipping master ${master.options.host}:${master.options.port} - not ready`);
        continue;
      }

      try {
        let cursor = '0';
        let scannedKeys = 0;
        
        do {
          const result = await master.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = result[0];
          const keys = result[1];
          keys.forEach(key => allKeys.add(key));
          scannedKeys += keys.length;
        } while (cursor !== '0');
        
        console.log(`Scanned ${scannedKeys} keys from master ${master.options.host}:${master.options.port}`);
      } catch (err) {
        console.error(`Error scanning keys from master ${master.options.host}:${master.options.port}:`, err.message);
      }
    }

    console.log(`Total unique keys found: ${allKeys.size}`);
    return Array.from(allKeys);
  } catch (err) {
    console.error('Error scanning Redis keys:', err.message);
    return [];
  }
}

// Enhanced Redis command wrapper
async function executeRedisCommand(commandFn, maxRetries = 3) {
  if (!isRedisReady()) {
    throw new Error('Redis cluster is not ready or operational');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await commandFn(redisCluster);
      return result;
    } catch (err) {
      console.error(`Redis command attempt ${attempt} failed:`, err.message);
      
      // Check if it's a connection issue
      if (err.message.includes('Connection is closed') || 
          err.message.includes('CLUSTERDOWN') ||
          redisCluster.status !== 'ready') {
        isRedisOperational = false;
        console.log('Redis connection issue detected, marking as not operational');
      }

      if (attempt === maxRetries) {
        throw err;
      }

      // Wait before retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await wait(delay);
    }
  }
}

// Start server initialization
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server starting on port ${PORT} (binding to 0.0.0.0)`);
  console.log(`🗄️  RDS Endpoint: ${process.env.RDS_ENDPOINT || 'localhost'}`);
  console.log(`📊 Redis Cluster: ${redisClusterEndpoint}:${redisPort}`);

  // Initialize Redis first
  try {
    await initRedis();
    console.log('✅ AWS ElastiCache Redis cluster initialization successful');
  } catch (err) {
    console.error('❌ AWS ElastiCache Redis cluster initialization failed:', err.message);
    console.log('⚠️  Server will continue without Redis functionality');
  }

  // RDS MySQL connection with retry logic and database creation
  let mysqlConnected = false;
  let retries = 10;
  
  console.log('🔍 Testing RDS MySQL connection...');
  
  // First, try to connect without specifying a database to create it if needed
  const mysqlPoolWithoutDb = mysql.createPool({
    host: process.env.RDS_ENDPOINT || 'localhost',
    user: process.env.RDS_MASTER_USERNAME || 'admin',
    password: process.env.RDS_MASTER_PASSWORD || 'password',
    port: process.env.RDS_PORT || 3306,
    ssl: process.env.RDS_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  // Try to create the database if it doesn't exist
  try {
    console.log('🔍 Checking if database exists...');
    const conn = await mysqlPoolWithoutDb.getConnection();
    
    const databaseName = process.env.RDS_DATABASE || 'userdb';
    
    // Check if database exists
    const [databases] = await conn.query('SHOW DATABASES LIKE ?', [databaseName]);
    
    if (databases.length === 0) {
      console.log(`📦 Database '${databaseName}' does not exist. Creating...`);
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
      console.log(`✅ Database '${databaseName}' created successfully`);
    } else {
      console.log(`✅ Database '${databaseName}' already exists`);
    }
    
    // Create users table if it doesn't exist
    await conn.query(`USE \`${databaseName}\``);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Users table ready');
    
    conn.release();
    await mysqlPoolWithoutDb.end();
    
  } catch (dbCreateErr) {
    console.error('❌ Error setting up database:', dbCreateErr.message);
    await mysqlPoolWithoutDb.end();
  }
  
  // Now try to connect to the specific database
  while (!mysqlConnected && retries > 0) {
    try {
      const conn = await mysqlPool.getConnection();
      console.log('✅ Connected to RDS MySQL database!');
      
      // Test the connection with a simple query
      const [result] = await conn.query('SELECT 1 as test');
      console.log('✅ RDS MySQL connection test successful:', result);
      
      conn.release();
      mysqlConnected = true;
    } catch (err) {
      console.error(`❌ RDS MySQL connection error (${retries} retries left):`, err.message);
      retries--;
      if (retries > 0) {
        await wait(5000);
      }
    }
  }

  if (!mysqlConnected) {
    console.error('❌ Failed to connect to RDS MySQL after all retries');
  }

  console.log('🎉 Server initialization completed');
  console.log(`📊 Status: RDS MySQL=${mysqlConnected ? 'connected' : 'disconnected'}, AWS ElastiCache Redis=${isRedisReady() ? 'ready' : 'not ready'}`);

  // Add a simple test endpoint to check what mode Redis is in
  app.get('/api/redis-mode', (req, res) => {
    if (!isRedisReady()) {
      return res.json({ mode: 'disconnected', status: 'Redis not available' });
    }

    const nodes = redisCluster.nodes('all').map(node => ({
      host: node.options.host,
      port: node.options.port,
      status: node.status
    }));
    
    res.json({
      mode: 'aws-elasticache-cluster',
      status: redisCluster.status,
      operational: isRedisOperational,
      endpoint: redisClusterEndpoint,
      port: redisPort,
      tls: redisUseTLS,
      nodes: nodes
    });
  });

  // --- APIs ---

  app.get('/api/health', async (req, res) => {
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

    // Perform a quick Redis operation test if it's supposedly ready
    let redisOperational = false;
    if (isRedisReady()) {
      try {
        await redisCluster.ping();
        redisOperational = true;
      } catch (err) {
        console.error('Redis ping failed in health check:', err.message);
        isRedisOperational = false;
      }
    }

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      rds_mysql: mysqlConnected ? 'connected' : 'disconnected',
      aws_elasticache_redis: redisOperational ? 'operational' : redisStatus,
      redis_cluster_endpoint: redisClusterEndpoint,
      redis_nodes: clusterNodes,
      uptime: process.uptime()
    });
  });

  // MySQL CRUD APIs (updated for RDS)

  app.get('/api/mysql/users', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users');
      res.json(rows);
    } catch (err) {
      console.error('RDS MySQL users fetch error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.get('/api/mysql/users/:id', async (req, res) => {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('RDS MySQL user fetch error:', err);
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
      console.error('RDS MySQL create user error:', err);
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
      console.error('RDS MySQL update user error:', err);
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
      console.error('RDS MySQL delete user error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Redis CRUD APIs (updated for AWS ElastiCache)

  app.get('/api/redis/users', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

    try {
      console.log('🔍 [DEBUG] Getting all Redis users from AWS ElastiCache...');
      console.log('🔍 [DEBUG] Redis cluster status:', redisCluster.status);
      
      const keys = await getAllKeysFromCluster('user:*');
      console.log('🔍 [DEBUG] Found keys:', keys);
      
      if (keys.length === 0) return res.json([]);

      const users = [];
      for (const key of keys) {
        try {
          const userData = await executeRedisCommand(client => client.hgetall(key));
          console.log('🔍 [DEBUG] User data for key', key, ':', userData);
          if (Object.keys(userData).length > 0) {
            users.push({ id: key.split(':')[1], ...userData });
          }
        } catch (err) {
          console.error(`Redis get user error for key ${key}:`, err.message);
        }
      }
      
      console.log('🔍 [DEBUG] Final users array:', users);
      res.json(users);
    } catch (err) {
      console.error('AWS ElastiCache Redis fetch users error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.get('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

    try {
      const userData = await executeRedisCommand(client => client.hgetall(`user:${req.params.id}`));
      if (Object.keys(userData).length === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ id: req.params.id, ...userData });
    } catch (err) {
      console.error('AWS ElastiCache Redis get user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.post('/api/redis/users', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

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
      console.error('AWS ElastiCache Redis create user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.put('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

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
      console.error('AWS ElastiCache Redis update user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  app.delete('/api/redis/users/:id', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

    try {
      const exists = await executeRedisCommand(client => client.exists(`user:${req.params.id}`));
      if (!exists) return res.status(404).json({ error: 'User not found' });

      await executeRedisCommand(client => client.del(`user:${req.params.id}`));
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      console.error('AWS ElastiCache Redis delete user error:', err);
      res.status(500).json({ error: 'Redis error: ' + err.message });
    }
  });

  // Copy RDS MySQL -> AWS ElastiCache Redis
  app.post('/api/mysql-to-redis', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

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
          console.error(`Error copying RDS MySQL user ${user.id} to AWS ElastiCache Redis:`, err.message);
        }
      }

      res.json({
        message: `Copied ${successCount} users from RDS MySQL to AWS ElastiCache Redis`,
        total: rows.length,
        success: successCount
      });
    } catch (err) {
      console.error('RDS MySQL to AWS ElastiCache Redis copy error:', err);
      res.status(500).json({ error: 'Operation failed: ' + err.message });
    }
  });

  // Copy AWS ElastiCache Redis -> RDS MySQL
  app.post('/api/redis-to-mysql', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

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
          console.error(`Error copying AWS ElastiCache Redis user ${key} to RDS MySQL:`, err.message);
          errorCount++;
        }
      }

      res.json({
        message: `Copied ${copiedCount} users from AWS ElastiCache Redis to RDS MySQL`,
        total: keys.length,
        success: copiedCount,
        errors: errorCount
      });
    } catch (err) {
      console.error('AWS ElastiCache Redis to RDS MySQL copy error:', err);
      res.status(500).json({ error: 'Operation failed: ' + err.message });
    }
  });

  // Cleanup duplicates in AWS ElastiCache Redis
  app.post('/api/redis/cleanup-duplicates', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

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
          console.error(`Error fetching AWS ElastiCache Redis user for key ${key}:`, err.message);
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
        message: 'AWS ElastiCache Redis cleanup completed',
        duplicatesRemoved: cleanedCount,
        idsReassigned: reassignedCount,
        totalProcessed: keys.length
      });
    } catch (err) {
      console.error('AWS ElastiCache Redis cleanup duplicates error:', err);
      res.status(500).json({ error: 'Cleanup failed: ' + err.message });
    }
  });

  // Test endpoint to validate AWS ElastiCache Redis functionality
  app.post('/api/redis/test', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'AWS ElastiCache Redis not ready' });

    try {
      await testRedisOperations();
      res.json({ 
        message: 'All AWS ElastiCache Redis tests passed successfully',
        cluster_endpoint: redisClusterEndpoint,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('AWS ElastiCache Redis test failed:', err);
      res.status(500).json({ 
        error: 'AWS ElastiCache Redis test failed: ' + err.message,
        cluster_endpoint: redisClusterEndpoint,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Additional endpoint to check AWS ElastiCache cluster status
  app.get('/api/redis/cluster-status', async (req, res) => {
    try {
      if (!isRedisReady()) {
        return res.json({
          isReady: false,
          connectionStatus: 'disconnected',
          cluster_endpoint: redisClusterEndpoint,
          timestamp: new Date().toISOString(),
          error: 'Redis cluster not ready'
        });
      }

      // Get cluster info
      const clusterInfo = await redisCluster.cluster('INFO');
      const clusterNodes = await redisCluster.cluster('NODES');
      
      // Parse cluster info
      const infoLines = clusterInfo.split('\r\n');
      const clusterState = infoLines.find(line => line.startsWith('cluster_state:'))?.split(':')[1];
      const clusterSlots = infoLines.find(line => line.startsWith('cluster_slots_assigned:'))?.split(':')[1];
      const clusterKnownNodes = infoLines.find(line => line.startsWith('cluster_known_nodes:'))?.split(':')[1];
      
      // Parse nodes info
      const nodes = clusterNodes.split('\n').filter(line => line.trim()).map(line => {
        const parts = line.split(' ');
        return {
          id: parts[0],
          address: parts[1],
          flags: parts[2],
          master: parts[3],
          ping_sent: parts[4],
          pong_recv: parts[5],
          config_epoch: parts[6],
          link_state: parts[7],
          slots: parts.slice(8).join(' ')
        };
      });

      res.json({
        isReady: true,
        connectionStatus: 'connected',
        cluster_endpoint: redisClusterEndpoint,
        cluster_state: clusterState,
        slots_assigned: clusterSlots,
        known_nodes: clusterKnownNodes,
        nodes: nodes,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('AWS ElastiCache cluster status check error:', err);
      res.status(500).json({ 
        error: 'Failed to check AWS ElastiCache cluster status: ' + err.message,
        cluster_endpoint: redisClusterEndpoint,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Endpoint to manually trigger AWS ElastiCache Redis reconnection
  app.post('/api/redis/reconnect', async (req, res) => {
    try {
      console.log('🔄 Manual AWS ElastiCache Redis reconnection triggered...');
      await initRedis();
      res.json({ 
        message: 'AWS ElastiCache Redis reconnection successful',
        status: isRedisReady() ? 'ready' : 'not ready',
        cluster_endpoint: redisClusterEndpoint,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('Manual AWS ElastiCache Redis reconnection failed:', err);
      res.status(500).json({ 
        error: 'AWS ElastiCache Redis reconnection failed: ' + err.message,
        cluster_endpoint: redisClusterEndpoint,
        timestamp: new Date().toISOString()
      });
    }
  });

  // New endpoint to test RDS connection
  app.get('/api/mysql/test', async (req, res) => {
    try {
      const conn = await mysqlPool.getConnection();
      const [result] = await conn.query('SELECT VERSION() as version, NOW() as current_time');
      conn.release();
      
      res.json({
        message: 'RDS MySQL connection test successful',
        database_info: result[0],
        endpoint: process.env.RDS_ENDPOINT || 'localhost',
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('RDS MySQL test failed:', err);
      res.status(500).json({
        error: 'RDS MySQL connection test failed: ' + err.message,
        endpoint: process.env.RDS_ENDPOINT || 'localhost',
        timestamp: new Date().toISOString()
      });
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down server...');
  try {
    if (redisCluster) {
      redisCluster.removeAllListeners();
      await redisCluster.disconnect();
      console.log('✅ AWS ElastiCache Redis cluster disconnected');
    }

    await mysqlPool.end();
    console.log('✅ RDS MySQL pool closed');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});