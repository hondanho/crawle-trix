import { CrawlerConfig } from "./configmanager.js";
import { StateManager } from "./statemanager.js";
import { PageManager } from "./pagemanager.js";
import { URLExtractor } from "./urlextractor.js";
import { DataCrawler } from "./datacrawler.js";
import { logger } from "../util/logger.js";
import { Browser } from "../util/browser.js";
import { runWorkers, WorkerState } from "../util/worker.js";
import { ScopedSeed } from "../util/seeds.js";

export class Crawler {
  config: CrawlerConfig;
  stateManager: StateManager;
  pageManager: PageManager;
  urlExtractor: URLExtractor;
  dataCrawler: DataCrawler;
  browser: Browser;
  seed: ScopedSeed;

  constructor(seed: ScopedSeed) {
    this.seed = seed;
    this.browser = new Browser();
    this.config = seed.config;
    this.stateManager = new StateManager(this.seed);
    this.pageManager = new PageManager(this.browser, this.seed);
    this.urlExtractor = new URLExtractor(
      this.stateManager,
      this.pageManager,
      this.seed,
    );
    this.dataCrawler = new DataCrawler(this.seed);
  }

  async init(): Promise<void> {
    await this.seed.init(this.browser);
    await this.stateManager.initCrawlStateInRedis();
  }

  async crawl(): Promise<void> {
    try {
      // merge seed with config
      await this.stateManager._addInitialSeeds(this.seed, this.urlExtractor);
      await runWorkers(this, this.seed);

      this.config.postCrawling = true;
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
    if (this.config.driver) {
      await this.config.driver({ page, data, crawler: this });
    } else {
      crawledData = await this.dataCrawler.crawlPage(page, data.url);
    }

    // Extract URLs
    await this.urlExtractor.preExtractLinks({
      crawledData,
      data,
      page,
    });
    await this.urlExtractor.extractLinks(
      page,
      data,
      this.seed.crawlConfig.selectLinkOtps,
      data,
    );
  }
}
