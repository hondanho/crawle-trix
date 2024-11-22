import { RedisCrawlState } from "../../util/state.js";
import { CrawlerArgs } from "../../util/argParser.js";
import { secondsElapsed, sleep } from "../../util/timing.js";
import { getDirSize } from "../../util/storage.js";
import { IStateManager } from "./interfaces.js";
import { logger } from "../../util/logger.js";
import { ScopedSeed } from "../../util/seeds.js";
import { initRedis } from "../../util/redis.js";
import os from "os";

// Quản lý state của crawler
export class StateManager implements IStateManager {
  public crawlState: RedisCrawlState;
  private startTime: number;

  constructor() {
    this.crawlState = null as unknown as RedisCrawlState; // Khởi tạo null và type cast
    this.startTime = Date.now();
  }

  async updateState(status: string): Promise<void> {
    await this.crawlState.setStatus(status);
  }

  async initCrawlState(
    params: CrawlerArgs,
    seeds: ScopedSeed[],
    crawlId: string
  ) {
    const redisUrl = this.getRedisUrl(params);
    if (!redisUrl.startsWith("redis://")) {
      logger.fatal(
        "stateStoreUrl must start with redis:// -- Only redis-based store currently supported"
      );
    }

    let redis;

    while (true) {
      try {
        redis = await initRedis(redisUrl);
        break;
      } catch (e) {
        //logger.fatal("Unable to connect to state store Redis: " + redisUrl);
        logger.warn(`Waiting for redis at ${redisUrl}`, {}, "state");
        await sleep(1);
      }
    }

    logger.debug(
      `Storing state via Redis ${redisUrl} @ key prefix "${crawlId}"`,
      {},
      "state"
    );

    logger.debug(`Max Page Time: ${params.maxPageTime} seconds`, {}, "state");

    this.crawlState = new RedisCrawlState(
      redis,
      crawlId,
      params.maxPageTime as number,
      os.hostname()
    );

    if (params.redisStoreClean) {
      // Thêm logic xóa Redis
      try {
        if (this.crawlState) {
          const redis = this.crawlState.redis;
          logger.info("Xóa toàn bộ dữ liệu Redis...");
          await redis.flushall();
          logger.info("Đã xóa thành công dữ liệu Redis");
        }
      } catch (e) {
        logger.error("Lỗi khi xóa Redis", e);
      }
    }

    // load full state from config
    if (params.state) {
      await this.crawlState.load(params.state, seeds, true);
      // otherwise, just load extra seeds
    } else {
      await this.loadExtraSeeds(seeds);
    }

    // clear any pending URLs from this instance
    await this.crawlState.clearOwnPendingLocks();

    if (params.saveState === "always" && params.saveStateInterval) {
      logger.debug(
        `Saving crawl state every ${params.saveStateInterval} seconds, keeping last ${params.saveStateHistory} states`,
        {},
        "state"
      );
    }

    if (params.logErrorsToRedis) {
      logger.setLogErrorsToRedis(true);
      logger.setCrawlState(this.crawlState);
    }

    return this.crawlState;
  }

  async loadExtraSeeds(seeds: ScopedSeed[]) {
    const extraSeeds = await this.crawlState.getExtraSeeds();

    for (const { origSeedId, newUrl } of extraSeeds) {
      const seed = seeds[origSeedId];
      seeds.push(seed.newScopedSeed(newUrl));
    }
  }

  private getRedisUrl(params: CrawlerArgs): string {
    if (process.platform !== "linux") {
      return (
        process.env.REDIS_URL ||
        params.redisStoreUrl ||
        "redis://localhost:6379/0"
      );
    }
    return (
      process.env.REDIS_URL_DOCKER ||
      params.redisStoreUrl ||
      "redis://localhost:6379/0"
    );
  }

  async checkLimits(
    params: CrawlerArgs,
    archivesDir: string
  ): Promise<boolean> {
    // Logic kiểm tra giới hạn
    const size = await this.updateCurrSize(params, archivesDir);

    if (params.sizeLimit && size >= params.sizeLimit) {
      return true;
    }

    if (params.timeLimit) {
      const elapsed = secondsElapsed(this.startTime);
      if (elapsed >= params.timeLimit) {
        return true;
      }
    }

    return false;
  }

  private async updateCurrSize(
    params: CrawlerArgs,
    archivesDir: string
  ): Promise<number> {
    if (params.dryRun) {
      return 0;
    }

    const size = await getDirSize(archivesDir);

    await this.crawlState.setArchiveSize(size);

    return size;
  }
}
