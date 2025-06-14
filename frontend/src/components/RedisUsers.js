import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fetchRedisUsers, deleteRedisUser } from '../services/apiService';

const RedisUsers = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        setLoading(true);
        const response = await fetchRedisUsers();
        setUsers(response.data);
        setError(null);
      } catch (error) {
        console.error('Error fetching users from Redis:', error);
        setError('Failed to load users from Redis cluster');
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [refreshTrigger]);

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this user?')) {
      try {
        await deleteRedisUser(id);
        setMessage({ type: 'success', text: 'User deleted successfully' });
        // Refresh the user list
        setRefreshTrigger(prev => prev + 1);
        
        // Clear message after 3 seconds
        setTimeout(() => {
          setMessage(null);
        }, 3000);
      } catch (error) {
        console.error('Error deleting user:', error);
        setMessage({ type: 'error', text: 'Failed to delete user' });
      }
    }
  };

  const filteredUsers = users.filter(user => {
    const searchLower = searchTerm.toLowerCase();
    return (
      user.name.toLowerCase().includes(searchLower) ||
      user.email.toLowerCase().includes(searchLower) ||
      (user.phone && user.phone.toLowerCase().includes(searchLower)) ||
      (user.address && user.address.toLowerCase().includes(searchLower))
    );
  });

  return (
    <div className="redis-users">
      <h2>Redis Cluster Records</h2>
      
      {message && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
          {message.text}
        </div>
      )}
      
      <div className="actions-bar">
        <Link to="/add" className="btn btn-primary">Add New User</Link>
        
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search users..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button 
              className="btn btn-secondary"
              onClick={() => setSearchTerm('')}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      
      {loading ? (
        <div className="loading">Loading users from Redis...</div>
      ) : error ? (
        <div className="alert alert-danger">{error}</div>
      ) : filteredUsers.length === 0 ? (
        <div className="empty-message">
          {searchTerm 
            ? 'No users found matching your search criteria' 
            : 'No users found in Redis cluster. Add some users or sync from MySQL to get started!'}
        </div>
      ) : (
        <table className="user-list">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Address</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map(user => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.phone || '-'}</td>
                <td>{user.address || '-'}</td>
                <td>
                  <Link 
                    to={`/edit/redis/${user.id}`} 
                    className="btn btn-secondary"
                    style={{ marginRight: '5px' }}
                  >
                    Edit
                  </Link>
                  <button 
                    className="btn btn-danger"
                    onClick={() => handleDelete(user.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default RedisUsers;