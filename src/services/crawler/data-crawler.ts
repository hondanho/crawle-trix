import { HTTPResponse, Page } from "puppeteer-core";
import { logger } from "../../util/logger.js";
import {
  downloadAllResources,
  downloadResourceFromUrl,
} from "../../util/storage.js";
import { collectLinkAssets } from "../../util/dom.js";
import { CrawlerConfig } from "./config-manager.js";

export class DataCrawler {
  private resources: { url: string; type: string; response?: HTTPResponse }[] =
    [];

  async crawlPage(page: Page, url: string, options: CrawlerConfig) {
    const { archivesDir, params } = options;
    const saveAllResources = params.saveAllResources;
    const originUrl = new URL(url);
    const originDomain = originUrl.origin;

    // Setup request interception
    await page.setRequestInterception(true);

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
      await page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      // Collect assets
      this.resources = await collectLinkAssets(
        this.resources,
        page,
        originDomain
      );

      // Download resources
      if (saveAllResources) {
        await downloadAllResources(this.resources, { page: url }, archivesDir);
      } else {
        await downloadResourceFromUrl(url, archivesDir);
      }

      return {
        title: await page.title(),
        content: await page.content(),
        resources: this.resources,
      };
    } catch (e) {
      logger.error("Failed to crawl page", e);
      throw e;
    }
  }
}
