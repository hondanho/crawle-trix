import fs from "fs";
import { CDPSession, Frame, Protocol } from "puppeteer-core";

import {
  ADD_LINK_FUNC,
  BEHAVIOR_LOG_FUNC,
  PAGE_OP_TIMEOUT_SECS,
} from "../util/constants.js";
import { Browser } from "../util/browser.js";
import { formatErr, logger } from "../util/logger.js";
import { collectCustomBehaviors } from "../util/file_reader.js";
import { sleep, timedRun } from "../util/timing.js";
import { WorkerOpts } from "../util/worker.js";
import { ScopedSeed } from "../util/seeds.js";
import { CrawlerConfig } from "./configmanager.js";

const behaviors = fs.readFileSync(
  new URL(
    "../../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url,
  ),
  { encoding: "utf8" },
);

// Quản lý xử lý page
export class PageManager {
  private browser: Browser;
  private config: CrawlerConfig;
  private seed: ScopedSeed;

  constructor(browser: Browser, seed: ScopedSeed) {
    this.browser = browser;
    this.config = seed.config;
    this.seed = seed;
  }

  async setupPage({
    page,
    workerid,
    cdp,
    callbacks,
    frameIdToExecId,
    isAuthSet,
  }: WorkerOpts) {
    await this.browser.setupPage({ page, cdp });

    await this.setupExecContextEvents(cdp, frameIdToExecId);

    if (
      (this.seed.crawlConfig.adBlockRules &&
        this.seed.crawlConfig.blockAds) ||
      this.seed.crawlConfig.blockRules ||
      this.seed.crawlConfig.originOverride
    ) {
      await page.setRequestInterception(true);

      if (this.seed.crawlConfig.adBlockRules && this.seed.crawlConfig.blockAds) {
        await this.seed.crawlConfig.adBlockRules.initPage(this.browser, page);
      }

      if (this.seed.crawlConfig.blockRuleOpts) {
        await this.seed.crawlConfig.blockRuleOpts.initPage(this.browser, page);
      }

      if (this.seed.crawlConfig.originOverrideOpts) {
        await this.seed.crawlConfig.originOverrideOpts.initPage(
          this.browser,
          page,
        );
      }
    }

    if (this.config.params.logging.includes("jserrors")) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          logger.warn(
            msg.text(),
            { location: msg.location(), page: page.url(), workerid },
            "jsError",
          );
        }
      });

      page.on("pageerror", (e) => {
        logger.warn(
          "Page Error",
          { ...formatErr(e), page: page.url() },
          "jsError",
        );
      });
    }

    await page.exposeFunction(
      ADD_LINK_FUNC,
      (url: string) => callbacks.addLink && callbacks.addLink(url),
    );

    if (this.seed.crawlConfig.behaviorOpts) {
      await page.exposeFunction(BEHAVIOR_LOG_FUNC, () => {});
      await this.browser.addInitScript(page, behaviors);

      const initScript = `
self.__bx_behaviors.init(${this.seed.crawlConfig.behaviorOpts}, false);
${this.seed.crawlConfig.customBehaviorsOtps}
self.__bx_behaviors.selectMainBehavior();
`;
      if (
        !this.seed.crawlConfig.behaviorsChecked &&
        this.seed.crawlConfig.customBehaviorsOtps
      ) {
        await this.checkBehaviorScripts(cdp);
        this.seed.crawlConfig.behaviorsChecked = true;
      }

      await this.browser.addInitScript(page, initScript);
    }

    const auth = this.seed.authHeader();
    if (auth) {
      logger.debug("Setting HTTP basic auth for seed", {
        seed: this.seed,
        seedUrl: this.seed.url,
      });
    }

    if (auth) {
      await page.setExtraHTTPHeaders({ Authorization: auth });
      isAuthSet = true;
    } else if (isAuthSet) {
      await page.setExtraHTTPHeaders({});
    }
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const sources = this.seed.crawlConfig.customBehaviors;

    if (!sources) {
      return;
    }

    for (const { path, contents } of await collectCustomBehaviors(
      sources as string[],
    )) {
      await this.browser.checkScript(cdp, path, contents);
    }
  }

  async awaitPageLoad(frame: Frame) {
    logger.debug("Waiting for custom page load via behavior", "behavior");
    try {
      await frame.evaluate(
        "self.__bx_behaviors && self.__bx_behaviors.awaitPageLoad();",
      );
    } catch (e) {
      logger.warn("Waiting for custom page load failed", e, "behavior");
    }

    if (this.seed.crawlConfig.postLoadDelay) {
      logger.info("Awaiting post load delay", {
        seconds: this.seed.crawlConfig.postLoadDelay,
      });
      await sleep(this.seed.crawlConfig.postLoadDelay);
    }
  }

  async shouldIncludeFrame(frame: Frame) {
    if (!frame.parentFrame()) {
      return frame;
    }

    const frameUrl = frame.url();

    if (!frameUrl) {
      return null;
    }

    // this is all designed to detect and skip PDFs, and other frames that are actually EMBEDs
    // if there's no tag or an iframe tag, then assume its a regular frame
    let tagName = "";

    try {
      tagName = await timedRun(
        frame.evaluate(
          "self && self.frameElement && self.frameElement.tagName",
        ),
        PAGE_OP_TIMEOUT_SECS,
        "Frame check timed out",
      );
    } catch (e) {
      // ignore
    }

    if (tagName && tagName !== "IFRAME" && tagName !== "FRAME") {
      return null;
    }

    let res;

    if (frameUrl === "about:blank") {
      res = false;
    } else {
      res =
        this.seed.crawlConfig.adBlockRules &&
        !this.seed.crawlConfig.adBlockRules.isAdUrl(frameUrl);
    }
    return res ? frame : null;
  }

  _behaviorLog(
    { data, type }: { data: string; type: string },
    pageUrl: string,
    workerid: number,
  ) {
    let behaviorLine;
    let message;
    let details;

    const logDetails = { page: pageUrl, workerid };

    if (typeof data === "string") {
      message = data;
      details = logDetails;
    } else {
      message = type === "info" ? "Behavior log" : "Behavior debug";
      details =
        typeof data === "object"
          ? { ...(data as object), ...logDetails }
          : logDetails;
    }

    switch (type) {
      case "info":
        behaviorLine = JSON.stringify(data);
        if (behaviorLine !== this.seed.crawlConfig.behaviorLastLine) {
          logger.info(message, details, "behaviorScript");
          this.seed.crawlConfig.behaviorLastLine = behaviorLine;
        }
        break;

      case "error":
        logger.error(message, details, "behaviorScript");
        break;

      case "debug":
      default:
        logger.debug(message, details, "behaviorScript");
    }
  }

  async setupExecContextEvents(
    cdp: CDPSession,
    frameIdToExecId: Map<string, number>,
  ) {
    await cdp.send("Runtime.enable");

    cdp.on(
      "Runtime.executionContextCreated",
      (params: Protocol.Runtime.ExecutionContextCreatedEvent) => {
        const { id, auxData } = params.context;
        if (auxData && auxData.isDefault && auxData.frameId) {
          frameIdToExecId.set(auxData.frameId, id);
        }
      },
    );

    cdp.on(
      "Runtime.executionContextDestroyed",
      (params: Protocol.Runtime.ExecutionContextDestroyedEvent) => {
        const { executionContextId } = params;
        for (const [frameId, execId] of frameIdToExecId.entries()) {
          if (execId === executionContextId) {
            frameIdToExecId.delete(frameId);
            break;
          }
        }
      },
    );

    cdp.on("Runtime.executionContextsCleared", () => {
      frameIdToExecId.clear();
    });
  }
}
