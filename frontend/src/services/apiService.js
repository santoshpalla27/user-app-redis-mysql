// API service for handling backend requests
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

export const fetchMySQLUsers = () => {
  return api.get('/api/mysql/users');
};

export const fetchMySQLUser = (id) => {
  return api.get(`/api/mysql/users/${id}`);
};

export const createMySQLUser = (userData) => {
  return api.post('/api/mysql/users', userData);
};

export const updateMySQLUser = (id, userData) => {
  return api.put(`/api/mysql/users/${id}`, userData);
};

export const deleteMySQLUser = (id) => {
  return api.delete(`/api/mysql/users/${id}`);
};

export const fetchRedisUsers = () => {
  return api.get('/api/redis/users');
};

export const fetchRedisUser = (id) => {
  return api.get(`/api/redis/users/${id}`);
};

export const createRedisUser = (userData) => {
  return api.post('/api/redis/users', userData);
};

export const updateRedisUser = (id, userData) => {
  return api.put(`/api/redis/users/${id}`, userData);
};

export const deleteRedisUser = (id) => {
  return api.delete(`/api/redis/users/${id}`);
};

export const syncMySQLToRedis = () => {
  return api.post('/api/mysql-to-redis');
};

export const syncRedisToMySQL = () => {
  return api.post('/api/redis-to-mysql');
};

export default api;