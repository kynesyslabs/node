-- Create databases for each node
CREATE DATABASE node1_db;
CREATE DATABASE node2_db;
CREATE DATABASE node3_db;
CREATE DATABASE node4_db;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE node1_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node2_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node3_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node4_db TO demosuser;
