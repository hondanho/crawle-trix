import { ConfigManager } from "./config-manager.js";
import { StateManager } from "./state-manager.js";
import { PageManager } from "./page-manager.js";
import { URLExtractor } from "./url-extractor.js";
import { DataCrawler } from "./data-crawler.js";
import { CrawlerArgs, parseArgs } from "../util/argParser.js";
import { logger } from "../util/logger.js";
import { LoadState, PageState } from "../util/state.js";
import { Browser } from "../util/browser.js";
import { runWorkers, WorkerState } from "../util/worker.js";
import { isHTMLMime } from "../util/reqresp.js";
import { Page } from "puppeteer-core";

export class Crawler {
  configManager: ConfigManager;
  stateManager: StateManager;
  pageManager: PageManager;
  urlExtractor: URLExtractor;
  dataCrawler: DataCrawler;

  browser: Browser;

  constructor() {
    this.browser = new Browser();
    this.configManager = new ConfigManager();
    this.stateManager = new StateManager(this.configManager);
    this.pageManager = new PageManager(this.browser, this.configManager);
    this.urlExtractor = new URLExtractor(this.configManager, this.stateManager);
    this.dataCrawler = new DataCrawler(this.configManager);
  }

  async init(): Promise<void> {
    const params = parseArgs() as CrawlerArgs;
    await this.configManager.initializeConfig(params);
    await this.configManager.initDirectories();
    await this.configManager.initLogging();
    await this.stateManager.initCrawlStateInRedis();
    await this.browser.launch(await this.configManager.getBrowserOptions());
  }

  async crawl(): Promise<void> {
    try {
      await this.stateManager._addInitialSeeds(this.urlExtractor);
      await runWorkers(this);
      this.configManager.config.postCrawling = true;
      logger.success("Crawling done");
      logger.setExternalLogStream(null);
    } catch (e) {
      logger.error("Crawl failed", e);
      await this.browser.close();
      await this.stateManager.updateState("done");
    }
  }

  public async crawlPage(opts: WorkerState): Promise<void> {
    const { page, data, callbacks, workerid } = opts;

    data.callbacks = callbacks;
    const { url, seedId } = data;
    const auth = this.configManager.config.seeds[seedId].authHeader();
    if (auth) {
      logger.debug("Setting HTTP basic auth for seed", {
        seedId,
        seedUrl: this.configManager.config.seeds[seedId].url,
      });
    }
    const logDetails = { page: url, workerid };
    data.logDetails = logDetails;
    data.workerid = workerid;
    opts.markPageUsed();
    if (auth) {
      await page.setExtraHTTPHeaders({ Authorization: auth });
      opts.isAuthSet = true;
    } else if (opts.isAuthSet) {
      await page.setExtraHTTPHeaders({});
    }

    // Crawl data
    let crawledData: any;
    if (this.configManager.config.driver) {
      await this.configManager.config.driver({ page, data, crawler: this });
    } else {
      crawledData = await this.dataCrawler.crawlPage(page, data.url);
    }

    await this.preExtractLinks(crawledData, data, page);

    // Extract URLs
    await this.urlExtractor.extractLinks(
      page,
      data,
      this.configManager.config.params.selectLinks,
      data,
    );
  }

  async preExtractLinks(crawledData: any, data: PageState, page: Page) {
    const { url, seedId, extraHops } = data;
    // Update state
    if (!crawledData.response) {
      throw new Error("no response for page load, assuming failed");
    }

    data.title = crawledData.title;
    const resp = crawledData.response;
    const respUrl = resp.url();

    if (this.configManager.config.params.depth === 0 && respUrl !== url) {
      data.seedId = await this.stateManager.crawlState.addExtraSeed(
        this.configManager.config.seeds,
        this.configManager.config.seeds.length,
        data.seedId,
        respUrl,
      );
      logger.info("Seed page redirected, adding redirected seed", {
        origUrl: url,
        newUrl: respUrl,
        seedId: data.seedId,
      });
    }
    data.status = resp?.status() || 200;
    const isChromeError = page.url().startsWith("chrome-error://");
    let failed = isChromeError;
    if (
      this.configManager.config.params.failOnInvalidStatus &&
      data.status >= 400
    ) {
      // Handle 4xx or 5xx response as a page load error
      failed = true;
    }

    if (failed) {
      logger.error(
        isChromeError ? "Page Crashed on Load" : "Page Invalid Status",
        {
          status,
        },
      );
      throw new Error("logged");
    }
    const contentType = resp.headers()["content-type"];

    if (contentType) {
      data.mime = contentType.split(";")[0];
      if (data.mime) {
        data.isHTMLPage = isHTMLMime(data.mime);
      }
    } else {
      // guess that its html if it fully loaded as a page
      data.isHTMLPage = !!crawledData.response;
    }
    if (crawledData.response) {
      data.loadState = LoadState.FULL_PAGE_LOADED;
    }
    if (!data.isHTMLPage) {
      data.filteredFrames = [];
      return;
    }

    await this.stateManager.updateState("running");

    // HTML Pages Only here
    data.filteredFrames = page
      .frames()
      .filter((frame) => this.pageManager.shouldIncludeFrame(frame));

    const seed = await this.stateManager.crawlState.getSeedAt(
      this.configManager.config.seeds,
      this.configManager.config.numOriginalSeeds,
      seedId,
    );

    if (!seed) {
      logger.error(
        "Seed not found, likely invalid crawl state - skipping link extraction and behaviors",
        { seedId },
      );
      return;
    }

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(this.configManager.config.params.depth, extraHops)) {
      logger.debug("Skipping Link Extraction, At Max Depth", {}, "links");
      return;
    }
    await this.pageManager.awaitPageLoad(page.mainFrame());
  }
}
