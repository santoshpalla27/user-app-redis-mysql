import React, { useState, useEffect } from 'react';
import { fetchMySQLUsers, fetchRedisUsers, syncMySQLToRedis, syncRedisToMySQL } from '../services/apiService';

const Dashboard = () => {
  const [mysqlCount, setMysqlCount] = useState(0);
  const [redisCount, setRedisCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncMessage, setSyncMessage] = useState(null);

  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const mysqlResponse = await fetchMySQLUsers();
        const redisResponse = await fetchRedisUsers();
        
        setMysqlCount(mysqlResponse.data.length);
        setRedisCount(redisResponse.data.length);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching data:', error);
        setLoading(false);
      }
    };
    
    fetchCounts();
  }, []);

  const handleSyncToRedis = async () => {
    try {
      setSyncMessage({ type: 'info', text: 'Syncing data from MySQL to Redis...' });
      const response = await syncMySQLToRedis();
      setSyncMessage({ type: 'success', text: response.data.message });
      
      // Refresh Redis count
      const redisResponse = await fetchRedisUsers();
      setRedisCount(redisResponse.data.length);
    } catch (error) {
      console.error('Error syncing to Redis:', error);
      setSyncMessage({ type: 'error', text: 'Failed to sync data to Redis' });
    }
  };

  const handleSyncToMySQL = async () => {
    try {
      setSyncMessage({ type: 'info', text: 'Syncing data from Redis to MySQL...' });
      const response = await syncRedisToMySQL();
      setSyncMessage({ type: 'success', text: response.data.message });
      
      // Refresh MySQL count
      const mysqlResponse = await fetchMySQLUsers();
      setMysqlCount(mysqlResponse.data.length);
    } catch (error) {
      console.error('Error syncing to MySQL:', error);
      setSyncMessage({ type: 'error', text: 'Failed to sync data to MySQL' });
    }
  };

  if (loading) {
    return <div className="loading">Loading dashboard data...</div>;
  }

  return (
    <div className="dashboard-container">
      <h2>Dashboard</h2>
      
      {syncMessage && (
        <div className={`alert ${syncMessage.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
          {syncMessage.text}
        </div>
      )}
      
      <div className="data-stats">
        <div className="stat-card">
          <h3>MySQL Records</h3>
          <p className="stat-number">{mysqlCount}</p>
        </div>
        <div className="stat-card">
          <h3>Redis Records</h3>
          <p className="stat-number">{redisCount}</p>
        </div>
      </div>
      
      <div className="card">
        <h3>Sync Data</h3>
        <p>Transfer user records between storage systems</p>
        <div className="sync-buttons">
          <button className="btn btn-primary" onClick={handleSyncToRedis}>
            MySQL → Redis
          </button>
          <button className="btn btn-secondary" onClick={handleSyncToMySQL}>
            Redis → MySQL
          </button>
        </div>
      </div>
      
      <div className="card">
        <h3>About This App</h3>
        <p>
          This User Record Management application demonstrates using multiple data storage options:
        </p>
        <ul style={{ textAlign: 'left' }}>
          <li>MySQL database for persistent relational data storage</li>
          <li>Redis Cluster for high-performance caching and NoSQL storage</li>
        </ul>
        <p>
          You can add users to either storage system, view records from both systems separately, 
          and sync data between them.
        </p>
      </div>
    </div>
  );
};

export default Dashboard;