import { Page } from "puppeteer-core";

import { formatErr, LogDetails, logger } from "../util/logger.js";
import {
  ADD_LINK_FUNC,
  ExtractSelector,
  PAGE_OP_TIMEOUT_SECS,
} from "../util/constants.js";
import { LoadState, PageState } from "../util/state.js";
import { QueueState } from "../util/state.js";
import { CrawlerConfig } from "./configmanager.js";
import { StateManager } from "./statemanager.js";
import { timedRun } from "../util/timing.js";
import { PageManager } from "./pagemanager.js";
import { isHTMLMime } from "../util/reqresp.js";
import { ScopedSeed } from "../util/seeds.js";
export class URLExtractor {
  private config: CrawlerConfig;
  private stateManager: StateManager;
  private pageManager: PageManager;
  private seed: ScopedSeed;
  constructor(
    stateManager: StateManager,
    pageManager: PageManager,
    seed: ScopedSeed,
  ) {
    this.config = seed.config;
    this.stateManager = stateManager;
    this.pageManager = pageManager;
    this.seed = seed;
  }

  async preExtractLinks({
    crawledData,
    data,
    page,
  }: {
    crawledData: any;
    data: PageState;
    page: Page;
  }) {
    const { url, extraHops } = data;
    // Update state
    if (!crawledData.response) {
      throw new Error("no response for page load, assuming failed");
    }

    data.title = crawledData.title;
    const resp = crawledData.response;
    const respUrl = resp.url();

    if (this.config.params.depth === 0 && respUrl !== url) {
      await this.stateManager.crawlState.addExtraSeed(this.seed, respUrl);
      logger.info("Seed page redirected, adding redirected seed", {
        origUrl: url,
        newUrl: respUrl,
      });
    }
    data.status = resp?.status() || 200;
    const isChromeError = page.url().startsWith("chrome-error://");
    let failed = isChromeError;
    if (this.config.params.failOnInvalidStatus && data.status >= 400) {
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

    // const seed = await this.stateManager.crawlState.getSeedAt(
    //   this.config.seeds,
    //   this.config.numOriginalSeeds,
    //   seedId,
    // );

    if (!this.seed) {
      logger.error(
        "Seed not found, likely invalid crawl state - skipping link extraction and behaviors",
        { seed: this.seed },
      );
      return;
    }

    // skip extraction if at max depth
    if (this.seed.isAtMaxDepth(this.config.params.depth, extraHops)) {
      logger.debug("Skipping Link Extraction, At Max Depth", {}, "links");
      return;
    }
    await this.pageManager.awaitPageLoad(page.mainFrame());
  }

  async extractLinks(
    page: Page,
    data: PageState,
    selectors: ExtractSelector[],
    logDetails: LogDetails,
  ) {
    const { depth, extraHops = 0, filteredFrames, callbacks } = data;

    callbacks.addLink = async (url: string) => {
      await this.queueInScopeUrls([url], depth, extraHops, false, logDetails);
    };

    const loadLinks = (options: {
      selector: string;
      extract: string;
      isAttribute: boolean;
      addLinkFunc: string;
    }) => {
      const { selector, extract, isAttribute, addLinkFunc } = options;
      const urls = new Set<string>();

      const getAttr = (elem: any) => urls.add(elem.getAttribute(extract));

      const getProp = (elem: any) => urls.add(elem[extract]);

      const getter = isAttribute ? getAttr : getProp;

      document.querySelectorAll(selector).forEach(getter);

      const addLinkFunction = (window as any)[addLinkFunc];
      urls.forEach((url) => {
        addLinkFunction(url);
      });

      return true;
    };

    const frames = filteredFrames || page.frames();

    try {
      for (const { selector, extract, isAttribute } of selectors) {
        await Promise.allSettled(
          frames.map((frame) => {
            const getLinks = frame
              .evaluate(loadLinks, {
                selector,
                extract,
                isAttribute,
                addLinkFunc: ADD_LINK_FUNC,
              })
              .catch((e) =>
                logger.warn("Link Extraction failed in frame", {
                  frameUrl: frame.url,
                  ...logDetails,
                  ...formatErr(e),
                }),
              );

            return timedRun(
              getLinks,
              PAGE_OP_TIMEOUT_SECS,
              "Link extraction timed out",
              logDetails,
            );
          }),
        );
      }
    } catch (e) {
      logger.warn("Link Extraction failed", e, "links");
    }
  }

  async queueInScopeUrls(
    urls: string[],
    depth: number,
    extraHops = 0,
    noOOS = false,
    logDetails: LogDetails = {},
  ) {
    try {
      depth += 1;

      // new number of extra hops, set if this hop is out-of-scope (oos)
      const newExtraHops = extraHops + 1;

      for (const possibleUrl of urls) {
        const res = this.getScope(
          {
            url: possibleUrl,
            extraHops: newExtraHops,
            depth,
            noOOS,
          },
          logDetails,
        );

        if (!res) {
          continue;
        }

        const { url, isOOS } = res;

        if (url) {
          await this.queueUrl(
            url,
            depth,
            isOOS ? newExtraHops : extraHops,
            logDetails,
          );
        }
      }
    } catch (e) {
      logger.error("Queuing Error", e, "links");
    }
  }

  protected getScope(
    {
      url,
      depth,
      extraHops,
      noOOS,
    }: {
      url: string;
      depth: number;
      extraHops: number;
      noOOS: boolean;
    },
    logDetails = {},
  ) {
    return this.seed.isIncluded(url, depth, extraHops, logDetails, noOOS);
  }

  async queueUrl(
    url: string,
    depth: number,
    extraHops: number,
    logDetails: LogDetails = {},
    ts = 0,
    pageId?: string,
  ) {
    if (this.seed.crawlConfig.limitHit) {
      return false;
    }

    const result = await this.stateManager.crawlState?.addToQueue(
      {
        pageid: pageId,
        ts,
        depth,
        extraHops,
        url,
        seedId: this.seed.id.toString(),
      },
      this.seed.crawlConfig.pageLimit,
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
        this.seed.crawlConfig.limitHit = true;
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
}
