import path from "path";
import os from "os";
import fsp from "fs/promises";
import yaml from "js-yaml";

import {
  LoadState,
  PageState,
  QueueState,
  RedisCrawlState,
} from "../util/state.js";
import { CrawlerArgs } from "../util/argParser.js";
import { secondsElapsed, sleep, timedRun } from "../util/timing.js";
import { getDirSize } from "../util/storage.js";
import { formatErr, LogDetails, logger } from "../util/logger.js";
import { ScopedSeed } from "../util/seeds.js";
import { initRedis } from "../util/redis.js";
import { ConfigManager, CrawlerConfig } from "./config-manager.js";
import { SitemapReader } from "../util/sitemapper.js";
import { URLExtractor } from "./url-extractor.js";
import { SITEMAP_INITIAL_FETCH_TIMEOUT_SECS } from "../util/constants.js";

// Quản lý state của crawler
export class StateManager {
  public crawlState: RedisCrawlState;
  private startTime: number;
  private configManager: ConfigManager;

  constructor(configEnv: ConfigManager) {
    this.configManager = configEnv;
    this.crawlState = null as unknown as RedisCrawlState; // Khởi tạo null và type cast
    this.startTime = Date.now();
  }

  async updateState(status: string): Promise<void> {
    await this.crawlState.setStatus(status);
  }

  async initCrawlStateInRedis() {
    const seeds = this.configManager.config.seeds;
    const redisUrl = this.getRedisUrl(this.configManager.config);
    if (!redisUrl.startsWith("redis://")) {
      logger.fatal(
        "stateStoreUrl must start with redis:// -- Only redis-based store currently supported",
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
      `Storing state via Redis ${redisUrl} @ key prefix "${this.configManager.config.params.crawlId}"`,
      {},
      "state",
    );

    logger.debug(
      `Max Page Time: ${this.configManager.config.maxPageTime} seconds`,
      {},
      "state",
    );

    this.crawlState = new RedisCrawlState(
      redis,
      this.configManager.config.params.crawlId,
      this.configManager.config.maxPageTime,
      os.hostname(),
    );

    if (this.configManager.config.params.redisStoreClean) {
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
    if (this.configManager.config.params.state) {
      await this.crawlState.load(
        this.configManager.config.params.state,
        seeds,
        true,
      );
      // otherwise, just load extra seeds
    } else {
      await this.loadExtraSeeds(seeds);
    }

    // clear any pending URLs from this instance
    await this.crawlState.clearOwnPendingLocks();

    if (
      this.configManager.config.params.saveState === "always" &&
      this.configManager.config.params.saveStateInterval
    ) {
      logger.debug(
        `Saving crawl state every ${this.configManager.config.params.saveStateInterval} seconds, keeping last ${this.configManager.config.params.saveStateHistory} states`,
        {},
        "state",
      );
    }

    if (this.configManager.config.params.logErrorsToRedis) {
      logger.setLogErrorsToRedis(true);
      logger.setCrawlState(this.crawlState);
    }

    return this.crawlState;
  }

  async checkCanceled() {
    if (this.crawlState && (await this.crawlState.isCrawlCanceled())) {
      await this.setStatusAndExit(0, "canceled");
    }
  }

  async getNextUrl(): Promise<PageState | null> {
    // Lấy URL tiếp theo từ danh sách chờ
    const nextUrl = await this.crawlState.redis.lpop("pending_urls");

    if (!nextUrl) {
      return null;
    }

    try {
      // Parse thông tin URL từ JSON
      const pageState: PageState = JSON.parse(nextUrl);

      // Thêm vào danh sách đã/đang crawl
      await this.crawlState.redis.hset(
        "crawled_urls",
        pageState.url,
        JSON.stringify(pageState),
      );

      return pageState;
    } catch (error) {
      logger.error("Error parsing URL from Redis:", error);
      return null;
    }
  }

  gracefulFinishOnInterrupt() {
    this.configManager.config.interrupted = true;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (
      !this.configManager.config.params.waitOnDone &&
      !this.configManager.config.params.restartsOnError
    ) {
      this.configManager.config.finalExit = true;
    }
  }

  async parseSitemap(
    { url, sitemap }: ScopedSeed,
    seedId: number,
    urlExtractor: URLExtractor,
  ) {
    if (!sitemap) {
      return;
    }

    if (await this.crawlState.isSitemapDone()) {
      logger.info("Sitemap already processed, skipping", "sitemap");
      return;
    }

    const fromDate = this.configManager.config.params.sitemapFromDate
      ? new Date(this.configManager.config.params.sitemapFromDate)
      : undefined;
    const toDate = this.configManager.config.params.sitemapToDate
      ? new Date(this.configManager.config.params.sitemapToDate)
      : undefined;
    const headers = this.configManager.config.headers;

    logger.info(
      "Fetching sitemap",
      { from: fromDate || "<any date>", to: fromDate || "<any date>" },
      "sitemap",
    );
    const sitemapper = new SitemapReader({
      headers,
      fromDate,
      toDate,
      limit: this.configManager.config.pageLimit,
    });

    try {
      await sitemapper.parse(sitemap, url);
    } catch (e) {
      logger.warn(
        "Sitemap for seed failed",
        { url, sitemap, ...formatErr(e) },
        "sitemap",
      );
      return;
    }

    let power = 1;
    let resolved = false;

    let finished = false;

    await new Promise<void>((resolve) => {
      sitemapper.on("end", () => {
        resolve();
        if (!finished) {
          logger.info(
            "Sitemap Parsing Finished",
            { urlsFound: sitemapper.count, limitHit: sitemapper.atLimit() },
            "sitemap",
          );

          if (this.crawlState) {
            this.crawlState
              .markSitemapDone()
              .catch((e) => logger.warn("Error marking sitemap done", e));
          }
          finished = true;
        }
      });

      sitemapper.on("url", ({ url }) => {
        const count = sitemapper.count;
        if (count % 10 ** power === 0) {
          if (count % 10 ** (power + 1) === 0 && power <= 3) {
            power++;
          }
          const sitemapsQueued = sitemapper.getSitemapsQueued();
          logger.debug(
            "Sitemap URLs processed so far",
            { count, sitemapsQueued },
            "sitemap",
          );
        }
        urlExtractor
          .queueInScopeUrls(seedId, [url], 0, 0, true, {})
          .catch((e: any) => logger.warn("Error queuing urls", e, "links"));
        if (count >= 100 && !resolved) {
          logger.info(
            "Sitemap partially parsed, continue parsing large sitemap in the background",
            { urlsFound: count },
            "sitemap",
          );
          resolve();
          resolved = true;
        }
      });
    });
  }

  async isCrawlRunning() {
    if (this.configManager.config.interrupted) {
      return false;
    }

    if (await this.crawlState.isCrawlCanceled()) {
      await this.setStatusAndExit(0, "canceled");
      return false;
    }

    if (await this.crawlState.isCrawlStopped()) {
      logger.info("Crawler is stopped");
      return false;
    }

    return true;
  }

  async _addInitialSeeds(urlExtractor: URLExtractor) {
    const seeds = this.configManager.config.seeds;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      if (!(await this.queueUrl(i, seed.url, 0, 0))) {
        if (this.configManager.config.limitHit) {
          break;
        }
      }

      if (seed.sitemap) {
        await timedRun(
          this.parseSitemap(seed, i, urlExtractor),
          SITEMAP_INITIAL_FETCH_TIMEOUT_SECS,
          "Sitemap initial fetch timed out",
          { sitemap: seed.sitemap, seed: seed.url },
          "sitemap",
        );
      }
    }
  }

  async queueUrl(
    seedId: number,
    url: string,
    depth: number,
    extraHops: number,
    logDetails: LogDetails = {},
    ts = 0,
    pageid?: string,
  ) {
    if (this.configManager.config.limitHit) {
      return false;
    }

    if (!this.crawlState) {
      return false;
    }
    const result = await this.crawlState.addToQueue(
      { url, seedId, depth, extraHops, ts, pageid },
      this.configManager.config.pageLimit,
    );

    switch (result) {
      case QueueState.ADDED:
        logger.debug("Queued new page url", { url, ...logDetails }, "links");
        return true;

      case QueueState.LIMIT_HIT:
        logger.debug(
          "Not queued page url, at page limit",
          { url, ...logDetails },
          "links",
        );
        this.configManager.config.limitHit = true;
        return false;

      case QueueState.DUPE_URL:
        logger.debug(
          "Not queued page url, already seen",
          { url, ...logDetails },
          "links",
        );
        return false;
    }

    return false;
  }

  async setStatusAndExit(exitCode: number, status: string) {
    logger.info(`Exiting, Crawl status: ${status}`);

    await this.closeLog();

    if (this.crawlState && status) {
      await this.crawlState.setStatus(status);
    }
    process.exit(exitCode);
  }

  async closeLog(): Promise<void> {
    // close file-based log
    logger.setExternalLogStream(null);
    if (!this.configManager.config.logFH) {
      return;
    }
    this.configManager.config.logFH = null;
  }

  async isInScope(
    {
      seedId,
      url,
      depth,
      extraHops,
    }: { seedId: number; url: string; depth: number; extraHops: number },
    logDetails = {},
  ): Promise<boolean> {
    const seed = await this.crawlState.getSeedAt(
      this.configManager.config.seeds,
      this.configManager.config.numOriginalSeeds,
      seedId,
    );

    return !!seed.isIncluded(url, depth, extraHops, logDetails);
  }

  async pageFinished(data: PageState) {
    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails, depth, url } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      logger.info("Page Finished", { loadState, ...logDetails }, "pageStatus");

      await this.crawlState.markFinished(url);

      if (this.configManager.config.healthChecker) {
        this.configManager.config.healthChecker.resetErrors();
      }

      await this.serializeConfig(false);

      await this.checkLimits(
        this.configManager.config.params,
        this.configManager.config.collDir,
      );
    } else {
      await this.crawlState.markFailed(url);

      if (this.configManager.config.healthChecker) {
        this.configManager.config.healthChecker.incError();
      }

      await this.serializeConfig(false);

      if (depth === 0 && this.configManager.config.params.failOnFailedSeed) {
        logger.fatal("Seed Page Load Failed, failing crawl", {}, "general", 1);
      }

      await this.checkLimits(
        this.configManager.config.params,
        this.configManager.config.collDir,
      );
    }
  }

  async serializeConfig(done = false) {
    switch (this.configManager.config.params.saveState) {
      case "never":
        return;

      case "partial":
        if (!done) {
          return;
        }
        if (await this.crawlState.isFinished()) {
          return;
        }
        break;

      case "always":
      default:
        break;
    }

    const now = new Date();

    if (!done) {
      // if not done, save state only after specified interval has elapsed
      if (
        secondsElapsed(this.configManager.config.lastSaveTime, now) <
        this.configManager.config.params.saveStateInterval
      ) {
        return;
      }
    }

    this.configManager.config.lastSaveTime = now.getTime();

    const ts = now.toISOString().slice(0, 19).replace(/[T:-]/g, "");

    const crawlDir = path.join(
      this.configManager.config.collDir,
      "collections",
    );

    await fsp.mkdir(crawlDir, { recursive: true });

    const filenameOnly = `crawl-${ts}-${this.configManager.config.params.crawlId}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.crawlState.serialize();

    if (this.configManager.config.params.origConfig) {
      this.configManager.config.params.origConfig.state = state;
    }
    const res = yaml.dump(this.configManager.config.params.origConfig, {
      lineWidth: -1,
    });
    try {
      logger.info(`Saving crawl state to: ${filename}`);
      await fsp.writeFile(filename, res);
    } catch (e) {
      logger.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    this.configManager.config.saveStateFiles.push(filename);

    if (
      this.configManager.config.saveStateFiles.length >
      this.configManager.config.params.saveStateHistory
    ) {
      const oldFilename = this.configManager.config.saveStateFiles.shift();
      logger.info(`Removing old save-state: ${oldFilename}`);
      try {
        await fsp.unlink(oldFilename || "");
      } catch (e) {
        logger.error(`Failed to delete old save state file: ${oldFilename}`);
      }
    }
  }

  async loadExtraSeeds(seeds: ScopedSeed[]) {
    const extraSeeds = await this.crawlState.getExtraSeeds();

    for (const { origSeedId, newUrl } of extraSeeds) {
      const seed = seeds[origSeedId];
      seeds.push(seed.newScopedSeed(newUrl));
    }
  }

  private getRedisUrl(config: CrawlerConfig): string {
    if (process.platform !== "linux") {
      return (
        process.env.REDIS_URL ||
        config.params.redisStoreUrl ||
        "redis://localhost:6379/0"
      );
    }
    return (
      process.env.REDIS_URL_DOCKER ||
      config.params.redisStoreUrl ||
      "redis://localhost:6379/0"
    );
  }

  async checkLimits(
    params: CrawlerArgs,
    archivesDir: string,
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
    archivesDir: string,
  ): Promise<number> {
    if (params.dryRun) {
      return 0;
    }

    const size = await getDirSize(archivesDir);

    await this.crawlState.setArchiveSize(size);

    return size;
  }
}
