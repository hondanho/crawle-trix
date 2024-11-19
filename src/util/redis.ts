import { Redis } from "ioredis";
import { logger } from "./logger.js";

const error = console.error;

let lastLogTime = 0;
let exitOnError = false;

// log only once every 10 seconds
const REDIS_ERROR_LOG_INTERVAL_SECS = 10000;

console.error = function (...args) {
  if (
    typeof args[0] === "string" &&
    args[0].indexOf("[ioredis] Unhandled error event") === 0
  ) {
    const now = Date.now();

    if (now - lastLogTime > REDIS_ERROR_LOG_INTERVAL_SECS) {
      if (lastLogTime && exitOnError) {
        logger.fatal("Crawl interrupted, redis gone, exiting", {}, "redis");
      }
      logger.warn("ioredis error", { error: args[0] }, "redis");
      lastLogTime = now;
    }
    return;
  }
  error.call(console, ...args);
};

export async function initRedis(url: string) {
  try {
    const redis = new Redis(url, {
      lazyConnect: false,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 3) {
          logger.error("Redis kết nối thất bại sau 3 lần thử");
          return null; // ngừng thử kết nối
        }
        return Math.min(times * 1000, 3000);
      },
    });

    // Thêm error listener
    redis.on("error", (err) => {
      logger.error("Redis error:", {
        error: err.message,
        url: url,
      });
    });

    // Kiểm tra trạng thái kết nối
    if (redis.status !== "connecting" && redis.status !== "connect") {
      await redis.connect();
    }

    // Kiểm tra kết nối bằng ping
    const ping = await redis.ping();
    if (ping !== "PONG") {
      throw new Error("Redis không phản hồi PONG");
    }

    return redis;
  } catch (err) {
    logger.error("Không thể kết nối Redis:", {
      error: err,
      url: url,
    });
    throw err;
  }
}

export function setExitOnRedisError() {
  exitOnError = true;
}
