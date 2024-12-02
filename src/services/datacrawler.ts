import { HTTPResponse, Page } from "puppeteer-core";

import { logger } from "../util/logger.js";
import { downloadAllResources, downloadResource } from "../util/storage.js";
import { CrawlerConfig } from "./configmanager.js";
import { ScopedSeed } from "../util/seeds.js";

export class DataCrawler {
  private config: CrawlerConfig;
  private seed: ScopedSeed;

  constructor(seed: ScopedSeed) {
    this.config = seed.config;
    this.seed = seed;
  }

  private resources: { url: string; type: string; response?: HTTPResponse }[] =
    [];

  async crawlPage(page: Page, url: string) {
    const { archivesDir, params } = this.config;
    const gotoOpts = this.seed.crawlConfig.gotoOpts;
    const saveAllResources = params.saveAllResources;
    const originUrl = new URL(url);
    const originDomain = originUrl.origin;

    // Setup request interception
    await page.setRequestInterception(true);

    if (!params.setJavaScriptEnabled) {
      await page.setJavaScriptEnabled(false);
    } else {
      await page.setJavaScriptEnabled(true);
    }

    page.on("request", async (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();

      try {
        // Allow main document request
        if (requestUrl === url) {
          await request.continue();
          return;
        }

        // Allow resources from same origin
        if (requestUrl.startsWith(originDomain)) {
          if (
            ["document", "script", "stylesheet", "image"].includes(resourceType)
          ) {
            this.resources.push({
              url: requestUrl,
              type: resourceType,
            });
            await request.continue();
          } else {
            await request.abort();
          }
        } else {
          await request.abort();
        }
      } catch (e) {
        try {
          await request.continue();
        } catch (err) {
          // Ignore errors for already handled requests
        }
      }
    });

    // Collect responses
    page.on("response", async (response) => {
      const request = response.request();
      const type = request.resourceType();

      if (
        ["image", "stylesheet", "script"].includes(type) &&
        request.url().startsWith(originDomain)
      ) {
        const resource = this.resources.find((r) => r.url === request.url());
        if (resource) {
          resource.response = response;
        }
      }
    });

    try {
      // Load page
      const reponsePage = await page.goto(url, gotoOpts);

      if (!reponsePage) {
        throw new Error("Failed to load page");
      } else {
        await downloadResource(await reponsePage.buffer(), url, archivesDir);
      }

      // Download resources
      if (saveAllResources) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        downloadAllResources(page, this.resources, originDomain, archivesDir);
      }

      return {
        title: await page.title(),
        content: await page.content(),
        response: reponsePage,
      };
    } catch (e) {
      logger.error("Failed to crawl page", e);
      throw e;
    }
  }
}
