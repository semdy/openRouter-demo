-- conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- messages
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);