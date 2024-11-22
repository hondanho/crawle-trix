import { CrawlerArgs } from "../../util/argParser.js";
import { Page } from "puppeteer-core";

export interface ICrawler {
  init(): Promise<void>;
  crawl(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface IConfigManager {
  initDirectories(): Promise<void>;
  initLogging(params: CrawlerArgs): Promise<void>;
}

export interface IStateManager {
  checkLimits(params: CrawlerArgs, archivesDir: string): Promise<boolean>;
  updateState(status: string): Promise<void>;
}

export interface IPageManager {
  setupPage(page: Page): Promise<void>;
}
