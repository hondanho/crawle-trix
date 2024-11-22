import { Browser } from "../../util/browser.js";
import { CrawlerArgs } from "../../util/argParser.js";

export abstract class BaseCrawler {
  public browser: Browser;
  protected params: CrawlerArgs;
  protected crawlId: string;

  constructor(params: CrawlerArgs) {
    this.params = params;
    this.browser = new Browser();
    this.crawlId = params.crawlId;
  }

  abstract init(): Promise<void>;
  abstract crawl(): Promise<void>;
  abstract cleanup(): Promise<void>;
}
