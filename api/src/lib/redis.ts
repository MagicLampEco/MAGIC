import { Redis } from "ioredis";
import { config } from "./config.js";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    _redis.on("error", (err: Error) => {
      console.error("[Redis] connection error:", err.message);
    });
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
