const Redis = require("ioredis");

class InMemoryRedis {
  constructor() {
    this.store = new Map();
    this.on = () => {};
    this.connect = async () => {};
    console.warn("Using in-memory fallback for Redis");
  }

  async get(key) {
    const data = this.store.get(key);
    if (!data) return null;
    if (data.expiry && Date.now() > data.expiry) {
      this.store.delete(key);
      return null;
    }
    return data.value;
  }

  async set(key, value, mode, duration) {
    const data = { value };
    if (mode === "EX" && duration) {
      data.expiry = Date.now() + duration * 1000;
    }
    this.store.set(key, data);
    return "OK";
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }
}

let redis = null;
let fallbackEnabled = false;

const connectRedis = () => {
  if (!process.env.REDIS_URL) {
    redis = new InMemoryRedis();
    return redis;
  }
  
  try {
    const client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    client.on("error", (err) => {
      if (!fallbackEnabled) {
        fallbackEnabled = true;
        console.warn("Redis unavailable, switching to in-memory cache:", err.message);
      }
      if (!(redis instanceof InMemoryRedis)) {
        redis = new InMemoryRedis();
        client.disconnect();
      }
    });

    client.connect().then(() => {
      console.log("Redis connected successfully via TLS");
    }).catch((err) => {
      if (!fallbackEnabled) {
        fallbackEnabled = true;
        console.warn("Redis connection failed, switching to in-memory cache:", err.message);
      }
      if (!(redis instanceof InMemoryRedis)) {
        redis = new InMemoryRedis();
      }
    });

    redis = client;
  } catch (err) {
    redis = new InMemoryRedis();
  }
  return redis;
};

const getRedis = () => redis || new InMemoryRedis();

module.exports = { connectRedis, getRedis };
