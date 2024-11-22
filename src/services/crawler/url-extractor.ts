import { Page } from "puppeteer-core";
import { formatErr, LogDetails, logger } from "../../util/logger.js";
import {
  ADD_LINK_FUNC,
  ExtractSelector,
  PAGE_OP_TIMEOUT_SECS,
} from "../../util/constants.js";
import { PageState } from "../../util/state.js";
import { QueueState } from "../../util/state.js";
import { CrawlerConfig } from "./config-manager.js";
import { timedRun } from "../../util/timing.js";

export class URLExtractor {
  async extractLinks(
    page: Page,
    data: PageState,
    selectors: ExtractSelector[],
    logDetails: LogDetails,
    config: CrawlerConfig
  ) {
    const { seedId, depth, extraHops = 0, filteredFrames, callbacks } = data;

    callbacks.addLink = async (url: string) => {
      await this.queueInScopeUrls(
        seedId,
        [url],
        depth,
        extraHops,
        false,
        logDetails,
        config
      );
    };

    const loadLinks = (options: {
      selector: string;
      extract: string;
      isAttribute: boolean;
      addLinkFunc: string;
    }) => {
      const { selector, extract, isAttribute, addLinkFunc } = options;
      const urls = new Set<string>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getAttr = (elem: any) => urls.add(elem.getAttribute(extract));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getProp = (elem: any) => urls.add(elem[extract]);

      const getter = isAttribute ? getAttr : getProp;

      document.querySelectorAll(selector).forEach(getter);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const func = (window as any)[addLinkFunc] as (
        url: string
      ) => NonNullable<unknown>;
      urls.forEach((url) => func.call(this, url));

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
                })
              );

            return timedRun(
              getLinks,
              PAGE_OP_TIMEOUT_SECS,
              "Link extraction timed out",
              logDetails
            );
          })
        );
      }
    } catch (e) {
      logger.warn("Link Extraction failed", e, "links");
    }
  }

  async queueInScopeUrls(
    seedId: number,
    urls: string[],
    depth: number,
    extraHops = 0,
    noOOS = false,
    logDetails: LogDetails = {},
    config: CrawlerConfig
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
            seedId,
            noOOS,
            config,
          },
          logDetails
        );

        if (!res) {
          continue;
        }

        const { url, isOOS } = res;

        if (url) {
          await this.queueUrl(
            seedId,
            url,
            depth,
            isOOS ? newExtraHops : extraHops,
            config,
            logDetails
          );
        }
      }
    } catch (e) {
      logger.error("Queuing Error", e, "links");
    }
  }

  async setupPage(page: Page) {
    // Expose function để thêm URL vào queue
    await page.exposeFunction(ADD_LINK_FUNC, async (url: string) => {
      // Trả về URL đã extract được
      return url;
    });
  }

  protected getScope(
    {
      seedId,
      url,
      depth,
      extraHops,
      noOOS,
      config,
    }: {
      seedId: number;
      url: string;
      depth: number;
      extraHops: number;
      noOOS: boolean;
      config: CrawlerConfig;
    },
    logDetails = {}
  ) {
    return config.seeds[seedId].isIncluded(
      url,
      depth,
      extraHops,
      logDetails,
      noOOS
    );
  }

  async queueUrl(
    seedId: number,
    url: string,
    depth: number,
    extraHops: number,
    config: CrawlerConfig,
    logDetails: LogDetails = {},
    ts = 0,
    pageid?: string
  ) {
    if (config.limitHit) {
      return false;
    }

    const result = await config.crawlState?.addToQueue(
      { url, seedId, depth, extraHops, ts, pageid },
      config.pageLimit
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
        config.limitHit = true;
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
}
