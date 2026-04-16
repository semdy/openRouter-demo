import { Pool } from "pg";
import { logger } from "../logger.js";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // maximum number of connections in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.info("sql_executed_query", { text, duration, rows: res.rowCount });
  return res;
};

export const getClient = async () => {
  const client = await pool.connect();
  const query = client.query;
  const release = client.release;

  const timeout = setTimeout(() => {
    logger.warn(
      "long_query_warning",
      `A client has been checked out for more than 5 seconds!
       The last executed query on this client was: ${client.lastQuery}`,
    );
  }, 5000);

  client.query = (...args) => {
    client.lastQuery = args;
    return query.apply(client, args);
  };

  client.release = () => {
    clearTimeout(timeout);
    client.query = query;
    client.release = release;
    return release.apply(client);
  };

  return client;
};
