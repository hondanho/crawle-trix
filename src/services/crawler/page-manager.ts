import { Page } from "puppeteer-core";
import { CrawlerArgs } from "../../util/argParser.js";
import { Browser } from "../../util/browser.js";
import { IPageManager } from "./interfaces.js";

// Quản lý xử lý page
export class PageManager implements IPageManager {
  private browser: Browser;
  private params: CrawlerArgs;

  constructor(browser: Browser, params: CrawlerArgs) {
    this.browser = browser;
    this.params = params;
  }

  async setupPage(page: Page): Promise<void> {
    await this.setupRequestInterception(page);
    //   await this.setupEventListeners(page);
    await this.configurePageSettings(page);
  }

  private async setupRequestInterception(page: Page): Promise<void> {
    await page.setRequestInterception(true);

    //   page.on("request", async request => {
    //     console.log("request", request);
    //     // Logic xử lý request
    //   });
  }

  private async setupEventListeners(page: Page): Promise<void> {
    page.on("response", async (response) => {
      console.log("response", response);
      // Logic xử lý response
    });
  }

  private async configurePageSettings(page: Page): Promise<void> {
    if (!this.params.setJavaScriptEnabled) {
      await page.setJavaScriptEnabled(false);
    }
  }
}
