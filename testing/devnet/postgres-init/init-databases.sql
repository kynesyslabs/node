-- Create databases for each node
CREATE DATABASE node1_db;
CREATE DATABASE node2_db;
CREATE DATABASE node3_db;
CREATE DATABASE node4_db;
-- node5_db is for the optional rehearsal-only fresh-joiner node (see
-- testing/forks/rehearsal/). It is harmless to create unconditionally —
-- the node-5 service is gated behind a docker-compose profile and only
-- starts when the rehearsal harness brings it up.
CREATE DATABASE node5_db;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE node1_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node2_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node3_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node4_db TO demosuser;
GRANT ALL PRIVILEGES ON DATABASE node5_db TO demosuser;
