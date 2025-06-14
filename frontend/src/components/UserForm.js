import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchMySQLUser, fetchRedisUser, createMySQLUser, createRedisUser, updateMySQLUser, updateRedisUser } from '../services/apiService';

const UserForm = () => {
  const { storage, id } = useParams();
  const navigate = useNavigate();
  const [selectedStorage, setSelectedStorage] = useState(storage || 'mysql');
  const [user, setUser] = useState({
    name: '',
    email: '',
    phone: '',
    address: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const isEditing = !!id;

  useEffect(() => {
    if (isEditing && storage && id) {
      const fetchUser = async () => {
        try {
          setLoading(true);
          const response = storage === 'mysql' 
            ? await fetchMySQLUser(id)
            : await fetchRedisUser(id);
          
          setUser(response.data);
          setLoading(false);
        } catch (error) {
          console.error('Error fetching user:', error);
          setError('Failed to load user data');
          setLoading(false);
        }
      };
      
      fetchUser();
    }
  }, [isEditing, storage, id]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setUser(prevUser => ({
      ...prevUser,
      [name]: value
    }));
  };

  const handleStorageChange = (e) => {
    setSelectedStorage(e.target.value);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    
    // Simple validation
    if (!user.name.trim() || !user.email.trim()) {
      setError('Name and email are required');
      return;
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(user.email)) {
      setError('Please enter a valid email address');
      return;
    }
    
    try {
      setLoading(true);
      
      if (isEditing) {
        // Update existing user
        if (storage === 'mysql') {
          await updateMySQLUser(id, user);
        } else {
          await updateRedisUser(id, user);
        }
        setSuccess('User updated successfully');
      } else {
        // Create new user
        if (selectedStorage === 'mysql') {
          await createMySQLUser(user);
        } else {
          await createRedisUser(user);
        }
        setSuccess('User created successfully');
        // Reset form if creating new user
        setUser({
          name: '',
          email: '',
          phone: '',
          address: ''
        });
      }
      
      setLoading(false);
      
      // Redirect after a short delay
      setTimeout(() => {
        navigate(isEditing ? `/${storage}` : `/${selectedStorage}`);
      }, 1500);
    } catch (error) {
      setLoading(false);
      if (error.response && error.response.data.error) {
        setError(error.response.data.error);
      } else {
        setError('An error occurred while saving the user');
      }
      console.error('Error saving user:', error);
    }
  };

  if (loading && isEditing) {
    return <div className="loading">Loading user data...</div>;
  }

  return (
    <div className="card">
      <h2>{isEditing ? 'Edit User' : 'Add New User'}</h2>
      
      {error && <div className="alert alert-danger">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}
      
      <form onSubmit={handleSubmit}>
        {!isEditing && (
          <div className="form-group storage-selector">
            <label htmlFor="storage">Storage Type:</label>
            <select
              id="storage"
              className="form-control"
              value={selectedStorage}
              onChange={handleStorageChange}
            >
              <option value="mysql">MySQL Database</option>
              <option value="redis">Redis Cluster</option>
            </select>
          </div>
        )}
        
        <div className="form-group">
          <label htmlFor="name">Name:</label>
          <input
            type="text"
            id="name"
            name="name"
            className="form-control"
            value={user.name}
            onChange={handleChange}
            required
          />
        </div>
        
        <div className="form-group">
          <label htmlFor="email">Email:</label>
          <input
            type="email"
            id="email"
            name="email"
            className="form-control"
            value={user.email}
            onChange={handleChange}
            required
          />
        </div>
        
        <div className="form-group">
          <label htmlFor="phone">Phone:</label>
          <input
            type="tel"
            id="phone"
            name="phone"
            className="form-control"
            value={user.phone}
            onChange={handleChange}
          />
        </div>
        
        <div className="form-group">
          <label htmlFor="address">Address:</label>
          <textarea
            id="address"
            name="address"
            className="form-control"
            value={user.address}
            onChange={handleChange}
            rows="3"
          ></textarea>
        </div>
        
        <div className="form-group" style={{ display: 'flex', gap: '10px' }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving...' : (isEditing ? 'Update User' : 'Add User')}
          </button>
          <button 
            type="button" 
            className="btn btn-secondary"
            onClick={() => navigate(isEditing ? `/${storage}` : '/')}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

export default UserForm;