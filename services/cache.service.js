const { getRedis } = require("../config/redis");

const getCache = async (key) => {
  const redis = getRedis();
  if (!redis) return null;
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
};

const setCache = async (key, value, ttlSec = 60) => {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(key, JSON.stringify(value), "EX", ttlSec);
};

module.exports = { getCache, setCache };
