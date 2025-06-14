CREATE DATABASE IF NOT EXISTS userdb;

USE userdb;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  phone VARCHAR(20),
  address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert some sample data
INSERT INTO users (name, email, phone, address) VALUES
  ('John Doe', 'john@example.com', '555-1234', '123 Main St, Anytown'),
  ('Jane Smith', 'jane@example.com', '555-5678', '456 Oak Ave, Somewhere'),
  ('Alice Johnson', 'alice@example.com', '555-9012', '789 Pine Rd, Nowhere');