import fs from "fs";
import { CDPSession, Frame, Protocol } from "puppeteer-core";

import {
  ADD_LINK_FUNC,
  BEHAVIOR_LOG_FUNC,
  PAGE_OP_TIMEOUT_SECS,
} from "../util/constants.js";
import { Browser } from "../util/browser.js";
import { formatErr, logger } from "../util/logger.js";
import { ConfigManager, CrawlerConfig } from "./config-manager.js";
import { collectCustomBehaviors } from "../util/file_reader.js";
import { WorkerOpts } from "../util/state.js";
import { sleep, timedRun } from "../util/timing.js";

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
  private configManager: ConfigManager;

  constructor(browser: Browser, configEnv: ConfigManager) {
    this.browser = browser;
    this.configManager = configEnv;
  }

  async setupPage({
    page,
    workerid,
    cdp,
    callbacks,
    frameIdToExecId,
  }: WorkerOpts) {
    await this.browser.setupPage({ page, cdp });

    await this.setupExecContextEvents(cdp, frameIdToExecId);

    if (
      (this.configManager.config.adBlockRules &&
        this.configManager.config.params.blockAds) ||
      this.configManager.config.blockRules ||
      this.configManager.config.originOverride
    ) {
      await page.setRequestInterception(true);

      if (
        this.configManager.config.adBlockRules &&
        this.configManager.config.params.blockAds
      ) {
        await this.configManager.config.adBlockRules.initPage(
          this.browser,
          page,
        );
      }

      if (this.configManager.config.blockRules) {
        await this.configManager.config.blockRules.initPage(this.browser, page);
      }

      if (this.configManager.config.originOverride) {
        await this.configManager.config.originOverride.initPage(
          this.browser,
          page,
        );
      }
    }

    if (this.configManager.config.params.logging.includes("jserrors")) {
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

    if (this.configManager.config.params.behaviorOpts) {
      await page.exposeFunction(BEHAVIOR_LOG_FUNC, () => {});
      await this.browser.addInitScript(page, behaviors);

      const initScript = `
self.__bx_behaviors.init(${this.configManager.config.params.behaviorOpts}, false);
${this.configManager.config.customBehaviors}
self.__bx_behaviors.selectMainBehavior();
`;
      if (
        !this.configManager.config.behaviorsChecked &&
        this.configManager.config.customBehaviors
      ) {
        await this.checkBehaviorScripts(cdp);
        this.configManager.config.behaviorsChecked = true;
      }

      await this.browser.addInitScript(page, initScript);
    }
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const sources = this.configManager.config.params.customBehaviors;

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

    if (this.configManager.config.params.postLoadDelay) {
      logger.info("Awaiting post load delay", {
        seconds: this.configManager.config.params.postLoadDelay,
      });
      await sleep(this.configManager.config.params.postLoadDelay);
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
        this.configManager.config.adBlockRules &&
        !this.configManager.config.adBlockRules.isAdUrl(frameUrl);
    }
    return res ? frame : null;
  }

  _behaviorLog(
    { data, type }: { data: string; type: string },
    pageUrl: string,
    workerid: number,
    config: CrawlerConfig,
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
        if (behaviorLine !== config.behaviorLastLine) {
          logger.info(message, details, "behaviorScript");
          config.behaviorLastLine = behaviorLine;
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
