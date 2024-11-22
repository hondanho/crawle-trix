import { ConfigManager, CrawlerConfig } from "./config-manager.js";
import { StateManager } from "./state-manager.js";
import { PageManager } from "./page-manager.js";
import { URLExtractor } from "./url-extractor.js";
import { DataCrawler } from "./data-crawler.js";
import { BaseCrawler } from "./base-crawler.js";
import { CrawlerArgs } from "../../util/argParser.js";
import { runWorkers, WorkerOpts, WorkerState } from "../../util/worker.js";
import { formatErr, LogDetails, logger } from "../../util/logger.js";
import { LoadState, PageState, QueueState } from "../../util/state.js";
import { secondsElapsed, timedRun } from "../../util/timing.js";
import {
  ADD_LINK_FUNC,
  BEHAVIOR_LOG_FUNC,
  SITEMAP_INITIAL_FETCH_TIMEOUT_SECS,
} from "../../util/constants.js";
import { ScopedSeed } from "../../util/seeds.js";
import { SitemapReader } from "../../util/sitemapper.js";
import fsp from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { CDPSession, Protocol } from "puppeteer-core";
import fs from "fs";
import { collectCustomBehaviors } from "../../util/file_reader.js";

const behaviors = fs.readFileSync(
  new URL(
    "../../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url
  ),
  { encoding: "utf8" }
);

export class Crawler extends BaseCrawler {
  configManager: ConfigManager;
  stateManager: StateManager;
  pageManager: PageManager;
  urlExtractor: URLExtractor;
  dataCrawler: DataCrawler;
  config: CrawlerConfig;

  constructor(params: CrawlerArgs) {
    super(params);
    this.configManager = new ConfigManager(params);
    this.stateManager = new StateManager();
    this.pageManager = new PageManager(this.browser, params);
    this.urlExtractor = new URLExtractor();
    this.dataCrawler = new DataCrawler();

    this.config = this.configManager.config;
  }

  async init(): Promise<void> {
    await this.configManager.initDirectories();
    await this.configManager.initLogging();
    await this.stateManager.initCrawlState(
      this.params,
      this.config.seeds,
      this.crawlId
    );
    await this.browser.launch(this.getBrowserOptions());
  }

  async crawl(): Promise<void> {
    try {
      await this._addInitialSeeds();
      await runWorkers(this, this.params.workers, this.config.maxPageTime);
      await this.postCrawl();
    } catch (e) {
      logger.error("Crawl failed", e);
      await this.cleanup();
    }
  }

  async isCrawlRunning() {
    if (this.configManager.config.interrupted) {
      return false;
    }

    if (await this.stateManager.crawlState.isCrawlCanceled()) {
      await this.setStatusAndExit(0, "canceled");
      return false;
    }

    if (await this.stateManager.crawlState.isCrawlStopped()) {
      logger.info("Crawler is stopped");
      return false;
    }

    return true;
  }

  async setStatusAndExit(exitCode: number, status: string) {
    logger.info(`Exiting, Crawl status: ${status}`);

    await this.closeLog();

    if (this.stateManager.crawlState && status) {
      await this.stateManager.crawlState.setStatus(status);
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

  async checkCanceled() {
    if (this.stateManager.crawlState && (await this.stateManager.crawlState.isCrawlCanceled())) {
      await this.setStatusAndExit(0, "canceled");
    }
  }

  gracefulFinishOnInterrupt() {
    this.configManager.config.interrupted = true;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (!this.params.waitOnDone && !this.params.restartsOnError) {
      this.configManager.config.finalExit = true;
    }
  }

  async postCrawl() {
    this.configManager.config.postCrawling = true;
    logger.success("Crawling done");

    if (
      this.params.waitOnDone &&
      (!this.configManager.config.interrupted ||
        this.configManager.config.finalExit)
    ) {
      this.configManager.config.done = true;
      logger.info("All done, waiting for signal...");
      await this.stateManager.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  async cleanup(): Promise<void> {
    await this.browser.close();
    await this.stateManager.updateState("done");
  }

  async isInScope(
    {
      seedId,
      url,
      depth,
      extraHops,
    }: { seedId: number; url: string; depth: number; extraHops: number },
    logDetails = {}
  ): Promise<boolean> {
    const seed = await this.stateManager.crawlState.getSeedAt(
      this.config.seeds,
      this.config.numOriginalSeeds,
      seedId
    );

    return !!seed.isIncluded(url, depth, extraHops, logDetails);
  }

  async pageFinished(data: PageState) {
    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails, depth, url } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      logger.info("Page Finished", { loadState, ...logDetails }, "pageStatus");

      await this.stateManager.crawlState.markFinished(url);

      if (this.config.healthChecker) {
        this.config.healthChecker.resetErrors();
      }

      await this.serializeConfig();

      await this.stateManager.checkLimits(this.params, this.config.collDir);
    } else {
      await this.stateManager.crawlState.markFailed(url);

      if (this.config.healthChecker) {
        this.config.healthChecker.incError();
      }

      await this.serializeConfig();

      if (depth === 0 && this.params.failOnFailedSeed) {
        logger.fatal("Seed Page Load Failed, failing crawl", {}, "general", 1);
      }

      await this.stateManager.checkLimits(this.params, this.config.collDir);
    }
  }

  async serializeConfig(done = false) {
    switch (this.params.saveState) {
      case "never":
        return;

      case "partial":
        if (!done) {
          return;
        }
        if (await this.stateManager.crawlState.isFinished()) {
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
        secondsElapsed(this.config.lastSaveTime, now) <
        this.params.saveStateInterval
      ) {
        return;
      }
    }

    this.config.lastSaveTime = now.getTime();

    const ts = now.toISOString().slice(0, 19).replace(/[T:-]/g, "");

    const crawlDir = path.join(this.config.collDir, "collections");

    await fsp.mkdir(crawlDir, { recursive: true });

    const filenameOnly = `crawl-${ts}-${this.params.crawlId}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.stateManager.crawlState.serialize();

    if (this.params.origConfig) {
      this.params.origConfig.state = state;
    }
    const res = yaml.dump(this.params.origConfig, { lineWidth: -1 });
    try {
      logger.info(`Saving crawl state to: ${filename}`);
      await fsp.writeFile(filename, res);
    } catch (e) {
      logger.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    this.config.saveStateFiles.push(filename);

    if (this.config.saveStateFiles.length > this.params.saveStateHistory) {
      const oldFilename = this.config.saveStateFiles.shift();
      logger.info(`Removing old save-state: ${oldFilename}`);
      try {
        await fsp.unlink(oldFilename || "");
      } catch (e) {
        logger.error(`Failed to delete old save state file: ${oldFilename}`);
      }
    }
  }

  async setupPage({
    page,
    cdp,
    workerid,
    callbacks,
    frameIdToExecId,
  }: WorkerOpts) {
    await this.browser.setupPage({ page, cdp });

    await this.setupExecContextEvents(cdp, frameIdToExecId);

    if (
      (this.config.adBlockRules && this.params.blockAds) ||
      this.config.blockRules ||
      this.config.originOverride
    ) {
      await page.setRequestInterception(true);

      if (this.config.adBlockRules && this.params.blockAds) {
        await this.config.adBlockRules.initPage(this.browser, page);
      }

      if (this.config.blockRules) {
        await this.config.blockRules.initPage(this.browser, page);
      }

      if (this.config.originOverride) {
        await this.config.originOverride.initPage(this.browser, page);
      }
    }

    if (this.params.logging.includes("jserrors")) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          logger.warn(
            msg.text(),
            { location: msg.location(), page: page.url(), workerid },
            "jsError"
          );
        }
      });

      page.on("pageerror", (e) => {
        logger.warn(
          "Page Error",
          { ...formatErr(e), page: page.url(), workerid },
          "jsError"
        );
      });
    }

    await page.exposeFunction(
      ADD_LINK_FUNC,
      (url: string) => callbacks.addLink && callbacks.addLink(url)
    );

    if (this.params.behaviorOpts) {
      await page.exposeFunction(
        BEHAVIOR_LOG_FUNC,
        (logdata: { data: string; type: string }) =>
          this._behaviorLog(logdata, page.url(), workerid)
      );
      await this.browser.addInitScript(page, behaviors);

      const initScript = `
self.__bx_behaviors.init(${this.params.behaviorOpts}, false);
${this.config.customBehaviors}
self.__bx_behaviors.selectMainBehavior();
`;
      if (!this.config.behaviorsChecked && this.config.customBehaviors) {
        await this.checkBehaviorScripts(cdp);
        this.config.behaviorsChecked = true;
      }

      await this.browser.addInitScript(page, initScript);
    }
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const sources = this.params.customBehaviors;

    if (!sources) {
      return;
    }

    for (const { path, contents } of await collectCustomBehaviors(
      sources as string[]
    )) {
      await this.browser.checkScript(cdp, path, contents);
    }
  }

  _behaviorLog(
    { data, type }: { data: string; type: string },
    pageUrl: string,
    workerid: number
  ) {
    let behaviorLine;
    let message;
    let details;

    const logDetails = { page: pageUrl, workerid };

    if (typeof data === "string") {
      message = data;
      details = logDetails;
    } else {
      message = type === "info" ? "Behavior log" : "Behavior debug";
      details =
        typeof data === "object"
          ? { ...(data as object), ...logDetails }
          : logDetails;
    }

    switch (type) {
      case "info":
        behaviorLine = JSON.stringify(data);
        if (behaviorLine !== this.config.behaviorLastLine) {
          logger.info(message, details, "behaviorScript");
          this.config.behaviorLastLine = behaviorLine;
        }
        break;

      case "error":
        logger.error(message, details, "behaviorScript");
        break;

      case "debug":
      default:
        logger.debug(message, details, "behaviorScript");
    }
  }

  async setupExecContextEvents(
    cdp: CDPSession,
    frameIdToExecId: Map<string, number>
  ) {
    await cdp.send("Runtime.enable");

    cdp.on(
      "Runtime.executionContextCreated",
      (params: Protocol.Runtime.ExecutionContextCreatedEvent) => {
        const { id, auxData } = params.context;
        if (auxData && auxData.isDefault && auxData.frameId) {
          frameIdToExecId.set(auxData.frameId, id);
        }
      }
    );

    cdp.on(
      "Runtime.executionContextDestroyed",
      (params: Protocol.Runtime.ExecutionContextDestroyedEvent) => {
        const { executionContextId } = params;
        for (const [frameId, execId] of frameIdToExecId.entries()) {
          if (execId === executionContextId) {
            frameIdToExecId.delete(frameId);
            break;
          }
        }
      }
    );

    cdp.on("Runtime.executionContextsCleared", () => {
      frameIdToExecId.clear();
    });
  }

  protected async _addInitialSeeds() {
    const seeds = this.config.seeds;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      if (!(await this.queueUrl(i, seed.url, 0, 0))) {
        if (this.config.limitHit) {
          break;
        }
      }

      if (seed.sitemap) {
        await timedRun(
          this.parseSitemap(seed, i),
          SITEMAP_INITIAL_FETCH_TIMEOUT_SECS,
          "Sitemap initial fetch timed out",
          { sitemap: seed.sitemap, seed: seed.url },
          "sitemap"
        );
      }
    }
  }

  async parseSitemap({ url, sitemap }: ScopedSeed, seedId: number) {
    if (!sitemap) {
      return;
    }

    if (await this.stateManager.crawlState.isSitemapDone()) {
      logger.info("Sitemap already processed, skipping", "sitemap");
      return;
    }

    const fromDate = this.params.sitemapFromDate
      ? new Date(this.params.sitemapFromDate)
      : undefined;
    const toDate = this.params.sitemapToDate
      ? new Date(this.params.sitemapToDate)
      : undefined;
    const headers = this.config.headers;

    logger.info(
      "Fetching sitemap",
      { from: fromDate || "<any date>", to: fromDate || "<any date>" },
      "sitemap"
    );
    const sitemapper = new SitemapReader({
      headers,
      fromDate,
      toDate,
      limit: this.config.pageLimit,
    });

    try {
      await sitemapper.parse(sitemap, url);
    } catch (e) {
      logger.warn(
        "Sitemap for seed failed",
        { url, sitemap, ...formatErr(e) },
        "sitemap"
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
            "sitemap"
          );

          if (this.stateManager.crawlState) {
            this.stateManager.crawlState
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
            "sitemap"
          );
        }
        this.urlExtractor
          .queueInScopeUrls(seedId, [url], 0, 0, true, {}, this.config)
          .catch((e) => logger.warn("Error queuing urls", e, "links"));
        if (count >= 100 && !resolved) {
          logger.info(
            "Sitemap partially parsed, continue parsing large sitemap in the background",
            { urlsFound: count },
            "sitemap"
          );
          resolve();
          resolved = true;
        }
      });
    });
  }

  async queueUrl(
    seedId: number,
    url: string,
    depth: number,
    extraHops: number,
    logDetails: LogDetails = {},
    ts = 0,
    pageid?: string
  ) {
    if (this.config.limitHit) {
      return false;
    }

    if (!this.stateManager.crawlState) {
      return false;
    }
    const result = await this.stateManager.crawlState.addToQueue(
      { url, seedId, depth, extraHops, ts, pageid },
      this.config.pageLimit
    );

    switch (result) {
      case QueueState.ADDED:
        logger.debug("Queued new page url", { url, ...logDetails }, "links");
        return true;

      case QueueState.LIMIT_HIT:
        logger.debug(
          "Not queued page url, at page limit",
          { url, ...logDetails },
          "links"
        );
        this.config.limitHit = true;
        return false;

      case QueueState.DUPE_URL:
        logger.debug(
          "Not queued page url, already seen",
          { url, ...logDetails },
          "links"
        );
        return false;
    }

    return false;
  }

  private getBrowserOptions() {
    return {
      profileUrl: this.params.profile,
      headless: this.params.headless,
      emulateDevice: this.config.emulateDevice,
      swOpt: this.params.serviceWorker,
      chromeOptions: {
        proxy: this.config.proxyServer,
        userAgent: this.config.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ondisconnect: (err: any) => {
        this.config.interrupted = true;
        logger.error(
          "Browser disconnected (crashed?), interrupting crawl",
          err,
          "browser"
        );
        this.config.browserCrashed = true;
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  extraChromeArgs() {
    const args = [];
    if (this.params.lang) {
      args.push(`--accept-lang=${this.params.lang}`);
    }
    return args;
  }

  public async crawlPage(opts: WorkerState): Promise<void> {
    const { page, data } = opts;

    // Setup page
    await this.pageManager.setupPage(page);

    // Extract URLs
    await this.urlExtractor.extractLinks(
      page,
      data,
      this.params.selectLinks,
      data,
      this.config
    );

    // Crawl data
    const crawledData = await this.dataCrawler.crawlPage(
      page,
      data.url,
      this.config
    );

    // Update state
    await this.updatePageState(data, crawledData);
  }

  private async updatePageState(
    data: PageState,
    crawledData: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<void> {
    data.title = crawledData.title;
    data.loadState = LoadState.FULL_PAGE_LOADED;
    await this.stateManager.updateState("running");
  }
}
