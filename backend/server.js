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

// Diagnostic function to check Redis cluster health
const diagnoseRedisCluster = async () => {
  console.log('🔍 Diagnosing Redis cluster connectivity...');
  
  // Test each node individually
  for (let i = 0; i < redisNodes.length; i++) {
    const node = redisNodes[i];
    console.log(`Testing node ${i + 1}/${redisNodes.length}: ${node.host}:${node.port}`);
    
    try {
      const singleNodeClient = new Redis({
        host: node.host,
        port: node.port,
        password: redisPassword,
        connectTimeout: 5000,
        commandTimeout: 3000,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });

      await singleNodeClient.connect();
      const pingResult = await singleNodeClient.ping();
      console.log(`  ✅ Node ${node.host}:${node.port} - Ping: ${pingResult}`);
      
      // Try to get cluster info if available
      try {
        const clusterInfo = await singleNodeClient.cluster('INFO');
        if (clusterInfo.includes('cluster_state:ok')) {
          console.log(`  ✅ Node ${node.host}:${node.port} - Cluster state: OK`);
        } else {
          console.log(`  ⚠️  Node ${node.host}:${node.port} - Cluster state: NOT OK`);
        }
      } catch (clusterErr) {
        console.log(`  ℹ️  Node ${node.host}:${node.port} - Not in cluster mode or cluster command failed`);
      }

      await singleNodeClient.disconnect();
    } catch (err) {
      console.log(`  ❌ Node ${node.host}:${node.port} - Failed: ${err.message}`);
    }
  }
};

// Initialize Redis cluster with comprehensive testing
const initRedis = async (maxAttempts = 3) => {
  // First, diagnose the cluster
  await diagnoseRedisCluster();
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🚀 Redis initialization attempt ${attempt}/${maxAttempts}`);
    
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

      console.log('Creating new Redis cluster connection...');

      // Try more conservative settings for unstable clusters
      redisCluster = new Redis.Cluster(redisNodes, {
        redisOptions: {
          password: redisPassword,
          connectTimeout: 15000, // Increased timeout
          commandTimeout: 10000, // Increased timeout
          retryDelayOnFailover: 500,
          maxRetriesPerRequest: 2, // Reduced retries to fail faster
          lazyConnect: false,
          keepAlive: 10000, // Reduced keep alive
          family: 4, // Force IPv4
          enableOfflineQueue: false, // Don't queue commands when disconnected
        },
        // Cluster-specific options
        clusterRetryDelayOnFailover: 3000,
        clusterRetryDelayOnClusterDown: 3000,
        clusterMaxRedirections: 8, // Reduced redirections
        slotsRefreshTimeout: 15000,
        slotsRefreshInterval: 60000, // Less frequent refresh
        enableReadyCheck: true,
        maxRetriesPerRequest: 2,
        scaleReads: 'master', // Always read from master for consistency
        natMap: {}, // Can be used if there are NAT issues
      });

      let readyPromiseResolve, readyPromiseReject;
      let connectionsStable = false;

      // Set up event handlers with connection stability tracking
      redisCluster.on('error', (err) => {
        console.error('❌ Redis Cluster Error:', err.message);
        isRedisOperational = false;
        if (readyPromiseReject) readyPromiseReject(err);
      });

      redisCluster.on('connect', () => {
        console.log('🔗 Redis cluster connected');
      });

      redisCluster.on('ready', () => {
        console.log('✅ Redis cluster ready');
        // Don't resolve immediately, wait for stability
      });

      redisCluster.on('close', () => {
        console.log('🔌 Redis cluster connection closed');
        isRedisOperational = false;
        connectionsStable = false;
      });

      redisCluster.on('reconnecting', (delayTime) => {
        console.log(`🔄 Redis cluster reconnecting in ${delayTime || 'unknown'}ms...`);
        isRedisOperational = false;
        connectionsStable = false;
      });

      redisCluster.on('end', () => {
        console.log('🔚 Redis cluster connection ended');
        isRedisOperational = false;
        connectionsStable = false;
      });

      // Additional cluster-specific events
      redisCluster.on('node error', (err, node) => {
        console.error(`❌ Redis node error ${node.options.host}:${node.options.port}:`, err.message);
        connectionsStable = false;
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
            console.log(`✅ Stability check ${stabilityCheckCount}/${maxStabilityChecks} passed`);
            
            if (stabilityCheckCount >= maxStabilityChecks) {
              connectionsStable = true;
              clearTimeout(timeout);
              resolve();
            } else {
              // Wait 2 seconds between stability checks
              setTimeout(checkStability, 2000);
            }
          } else {
            console.log(`⏳ Waiting for ready status, current: ${redisCluster.status}`);
            stabilityCheckCount = 0; // Reset counter if not ready
            setTimeout(checkStability, 1000);
          }
        };

        // Start stability checking after first ready event
        redisCluster.once('ready', () => {
          console.log('🔍 Starting stability checks...');
          setTimeout(checkStability, 1000);
        });

        // If already ready, start checking
        if (redisCluster.status === 'ready') {
          console.log('🔍 Starting stability checks (already ready)...');
          setTimeout(checkStability, 1000);
        }
      });

      console.log('✅ Redis cluster appears stable, testing operations...');

      // Test operations thoroughly
      await testRedisOperations();
      
      isRedisOperational = true;
      console.log('🎉 Redis cluster initialization completed successfully');
      return;

    } catch (err) {
      console.error(`❌ Redis initialization attempt ${attempt} failed:`, err.message);
      
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
        throw new Error(`Redis initialization failed after ${maxAttempts} attempts: ${err.message}`);
      }

      // Wait before next attempt
      const delay = attempt * 5000; // Longer delay
      console.log(`⏳ Waiting ${delay}ms before next attempt...`);
      await wait(delay);
    }
  }
};

// Improved helper: scan keys across cluster or single node
async function getAllKeysFromCluster(pattern) {
  if (!isRedisReady()) {
    console.log('Redis not ready, returning empty array');
    return [];
  }

  try {
    const allKeys = new Set();
    
    // Check if it's cluster mode - more reliable detection
    const isCluster = redisCluster instanceof Redis.Cluster || 
                     (redisCluster.constructor && redisCluster.constructor.name === 'Cluster') ||
                     (redisCluster.nodes && typeof redisCluster.nodes === 'function');
    
    if (isCluster) {
      // Cluster mode - scan all masters
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
    } else {
      // Single node mode - scan directly
      console.log(`Scanning single Redis node for pattern: ${pattern}`);
      
      let cursor = '0';
      let scannedKeys = 0;
      
      do {
        const result = await redisCluster.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        const keys = result[1];
        keys.forEach(key => allKeys.add(key));
        scannedKeys += keys.length;
      } while (cursor !== '0');
      
      console.log(`Scanned ${scannedKeys} keys from single node`);
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

// Fallback: Try single Redis connection if cluster fails
const initRedisFallback = async () => {
  console.log('🔄 Attempting Redis fallback to single node connection...');
  
  // Try the first node as a single Redis instance
  const firstNode = redisNodes[0];
  
  try {
    redisCluster = new Redis({
      host: firstNode.host,
      port: firstNode.port,
      password: redisPassword,
      connectTimeout: 10000,
      commandTimeout: 8000,
      retryDelayOnFailover: 500,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      keepAlive: 30000,
      family: 4,
    });

    // Set up basic event handlers
    redisCluster.on('error', (err) => {
      console.error('❌ Redis Single Node Error:', err.message);
      isRedisOperational = false;
    });

    redisCluster.on('connect', () => {
      console.log('🔗 Redis single node connected');
    });

    redisCluster.on('ready', () => {
      console.log('✅ Redis single node ready');
    });

    // Wait for connection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis single node connection timeout'));
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

    // Test basic operations
    console.log('🔍 Testing Redis single node operations...');
    await redisCluster.ping();
    console.log('✅ Single node ping successful');

    // Simple set/get test
    const testKey = 'test:fallback:' + Date.now();
    await redisCluster.set(testKey, 'fallback-test', 'EX', 30);
    const result = await redisCluster.get(testKey);
    if (result !== 'fallback-test') {
      throw new Error('Single node test failed');
    }
    await redisCluster.del(testKey);
    
    isRedisOperational = true;
    console.log('✅ Redis fallback to single node successful');
    return true;
    
  } catch (err) {
    console.error('❌ Redis single node fallback failed:', err.message);
    if (redisCluster) {
      try {
        await redisCluster.disconnect();
      } catch (disconnectErr) {
        // Ignore
      }
      redisCluster = null;
    }
    isRedisOperational = false;
    return false;
  }
};

// Start server initialization
app.listen(PORT, async () => {
  console.log(`🚀 Server starting on port ${PORT}`);

  // Initialize Redis first
  try {
    await initRedis();
    console.log('✅ Redis cluster initialization successful');
  } catch (err) {
    console.error('❌ Redis cluster initialization failed:', err.message);
    
    // Try fallback to single node
    console.log('🔄 Attempting Redis fallback...');
    const fallbackSuccess = await initRedisFallback();
    
    if (!fallbackSuccess) {
      console.log('⚠️  Server will continue without Redis functionality');
    }
  }

  // MySQL connection with retry logic
  let mysqlConnected = false;
  let retries = 10;
  
  console.log('🔍 Testing MySQL connection...');
  while (!mysqlConnected && retries > 0) {
    try {
      const conn = await mysqlPool.getConnection();
      console.log('✅ Connected to MySQL database!');
      conn.release();
      mysqlConnected = true;
    } catch (err) {
      console.error(`❌ MySQL connection error (${retries} retries left):`, err.message);
      retries--;
      if (retries > 0) {
        await wait(5000);
      }
    }
  }

  if (!mysqlConnected) {
    console.error('❌ Failed to connect to MySQL after all retries');
  }

  console.log('🎉 Server initialization completed');
  console.log(`📊 Status: MySQL=${mysqlConnected ? 'connected' : 'disconnected'}, Redis=${isRedisReady() ? 'ready' : 'not ready'}`);

  // Add a simple test endpoint to check what mode Redis is in
  app.get('/api/redis-mode', (req, res) => {
    if (!isRedisReady()) {
      return res.json({ mode: 'disconnected', status: 'Redis not available' });
    }

    // Check if it's cluster mode or single node - more reliable detection
    const isCluster = redisCluster instanceof Redis.Cluster || 
                     (redisCluster.constructor && redisCluster.constructor.name === 'Cluster') ||
                     (redisCluster.nodes && typeof redisCluster.nodes === 'function');
    
    res.json({
      mode: isCluster ? 'cluster' : 'single',
      status: redisCluster.status,
      operational: isRedisOperational,
      constructor: redisCluster.constructor.name,
      nodes: isCluster ? redisCluster.nodes('all').map(node => ({
        host: node.options.host,
        port: node.options.port,
        status: node.status
      })) : [{
        host: redisCluster.options.host || 'unknown',
        port: redisCluster.options.port || 'unknown',
        status: redisCluster.status
      }]
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
      mysql: mysqlConnected ? 'connected' : 'disconnected',
      redis_cluster: redisOperational ? 'operational' : redisStatus,
      redis_nodes: clusterNodes,
      uptime: process.uptime()
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
      console.log('🔍 [DEBUG] Getting all Redis users...');
      console.log('🔍 [DEBUG] Redis cluster type:', redisCluster.constructor.name);
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

  // Test endpoint to validate Redis functionality
  app.post('/api/redis/test', async (req, res) => {
    if (!isRedisReady()) return res.status(503).json({ error: 'Redis not ready' });

    try {
      await testRedisOperations();
      res.json({ 
        message: 'All Redis tests passed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('Redis test failed:', err);
      res.status(500).json({ 
        error: 'Redis test failed: ' + err.message,
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
      console.log('✅ Redis cluster disconnected');
    }

    await mysqlPool.end();
    console.log('✅ MySQL pool closed');

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
