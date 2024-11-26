import { ConfigManager } from "./config-manager.js";
import { StateManager } from "./state-manager.js";
import { PageManager } from "./page-manager.js";
import { URLExtractor } from "./url-extractor.js";
import { DataCrawler } from "./data-crawler.js";
import { CrawlerArgs, parseArgs } from "../util/argParser.js";
import { logger } from "../util/logger.js";
import { Browser } from "../util/browser.js";
import { runWorkers, WorkerState } from "../util/worker.js";

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
    this.urlExtractor = new URLExtractor(
      this.configManager,
      this.stateManager,
      this.pageManager,
    );
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
    opts.markPageUsed();
    data.callbacks = callbacks;
    data.logDetails = { page: data.url, workerid };
    data.workerid = workerid;

    // Crawl data
    let crawledData: any;
    if (this.configManager.config.driver) {
      await this.configManager.config.driver({ page, data, crawler: this });
    } else {
      crawledData = await this.dataCrawler.crawlPage(page, data.url);
    }

    // Extract URLs
    await this.urlExtractor.preExtractLinks(crawledData, data, page);
    await this.urlExtractor.extractLinks(
      page,
      data,
      this.configManager.config.params.selectLinks,
      data,
    );
  }
}
