import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';
import UserForm from './components/UserForm';
import MySQLUsers from './components/MySQLUsers';
import RedisUsers from './components/RedisUsers';
import Dashboard from './components/Dashboard';

function App() {
  return (
    <Router>
      <div className="App">
        <header className="App-header">
          <h1>User Record Management</h1>
          <nav>
            <ul>
              <li>
                <Link to="/">Dashboard</Link>
              </li>
              <li>
                <Link to="/add">Add User</Link>
              </li>
              <li>
                <Link to="/mysql">MySQL Records</Link>
              </li>
              <li>
                <Link to="/redis">Redis Records</Link>
              </li>
            </ul>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/add" element={<UserForm />} />
            <Route path="/mysql" element={<MySQLUsers />} />
            <Route path="/redis" element={<RedisUsers />} />
            <Route path="/edit/:storage/:id" element={<UserForm />} />
          </Routes>
        </main>
        <footer>
          <p>User Record App with React, Node.js, MySQL, and Redis Cluster</p>
        </footer>
      </div>
    </Router>
  );
}

export default App;