import os from "os";
import { createParser } from "css-selector-parser";
import { KnownDevices as devices } from "puppeteer-core";

import { logger } from "./logger.js";
import { interpolateFilename } from "./storage.js";
import { BEHAVIOR_LOG_FUNC, DEFAULT_SELECTORS, ExtractSelector, MAX_DEPTH, PAGE_OP_TIMEOUT_SECS } from "./constants.js";
import { ISeed, ISeedConfig, ISeedDataConfig } from "../models/seed.js";
import { Browser } from "./browser.js";
import { collectCustomBehaviors } from "./file_reader.js";
import { BlockRules } from "./blockrules.js";
import { BlockRuleDecl } from "./blockrules.js";
import { AdBlockRules } from "./blockrules.js";
import { initProxy } from "./proxy.js";
import { CrawlerConfig } from "../services/configmanager.js";
import { OriginOverride } from "./originoverride.js";

export type ScopeType =
  | "prefix"
  | "host"
  | "domain"
  | "page"
  | "page-spa"
  | "any"
  | "custom";

const RUN_DETACHED = process.env.DETACHED_CHILD_PROC == "1";

export abstract class SeedBase implements ISeed {
  id: string;
  name: string;
  url: string;

  dataConfig: ISeedDataConfig;
  crawlConfig: ISeedConfig & {
    include: RegExp[];
    exclude: RegExp[];
    selectLinkOtps: ExtractSelector[];
    behaviorOpts: string;
    emulateDevice: any;
    headers: Record<string, string>;
    customBehaviorsOtps: string;
    gotoOpts: Record<string, any>;

    blockRuleOpts: BlockRules | null;
    adBlockRules: AdBlockRules | null;

    originOverrideOpts: OriginOverride | null;

    browserCrashed: boolean;
    interrupted: boolean;
    behaviorLastLine: string;
  };

  constructor(seed: ISeed) {
    this.id = seed.id;
    this.name = seed.name;
    this.url = seed.url;

    this.dataConfig = seed.dataConfig;
    this.crawlConfig = {
      ...seed.crawlConfig,
      include: [],
      exclude: [],
      selectLinks: [],
      selectLinkOtps: [],
      behaviorOpts: "",
      emulateDevice: null,
      headers: {},
      customBehaviorsOtps: "",
      gotoOpts: {
        waitUntil: "domcontentloaded",
        timeout: 0,
      },
      blockRuleOpts: null,
      adBlockRules: null,
      browserCrashed: false,
      interrupted: false,
      behaviorLastLine: "",
      blockRules: null,
      originOverrideOpts: null,
    };
  }
}

export class ScopedSeed extends SeedBase {
  private _authEncoded: string | null = null;
  crawlId: string | null;
  collection: string | null;
  config: CrawlerConfig;

  constructor(seed: ISeed, config: CrawlerConfig) {
    super(seed);
    this.config = config;
    this.crawlId = null;
    this.collection = null;
  }

  async init(browser: Browser) {
    await this.setupConfig(browser);
    await browser.launch(await this.getBrowserOptions());
  }

  async setupConfig(browser: Browser) {
    this.crawlId = process.env.CRAWL_ID || os.hostname();
    this.collection = interpolateFilename(this.name, this.crawlId);

    if (this.crawlConfig.enableBehaviors) {
      const behaviorOpts: { [key: string]: string | boolean } = {};
      if (this.crawlConfig.behaviors.length > 0) {
        this.crawlConfig.behaviors.forEach((x: string) => (behaviorOpts[x] = true));
        behaviorOpts.log = BEHAVIOR_LOG_FUNC;
        behaviorOpts.startEarly = true;
        this.crawlConfig.behaviorOpts = JSON.stringify(behaviorOpts);
      } else {
        this.crawlConfig.behaviorOpts = "";
      }
    } else {
      this.crawlConfig.behaviorOpts = "";
    }

    if (this.crawlConfig.mobileDevice) {
      this.crawlConfig.emulateDevice = (devices as Record<string, any>)[
        this.crawlConfig.mobileDevice.replace("-", " ")
      ];
      if (!this.crawlConfig.emulateDevice) {
        logger.fatal("Unknown device: " + this.crawlConfig.mobileDevice);
      }
    } else {
      this.crawlConfig.emulateDevice = { viewport: null };
    }

    let selectLinks: ExtractSelector[];
    const parser = createParser();
    if (this.crawlConfig.selectLinks && this.crawlConfig.selectLinks.length > 0) {
      selectLinks = this.crawlConfig.selectLinks.map((x: string) => {
        const parts = x.split("->");
        const selector = parts[0];
        const value = parts[1] || "";
        const extract = parts.length > 1 ? value.replace("@", "") : "href";
        const isAttribute = value.startsWith("@");
        try {
          parser(selector);
        } catch (e) {
          logger.fatal("Invalid Link Extraction CSS Selector", { selector });
        }
        return { selector, extract, isAttribute };
      });
    } else {
      selectLinks = DEFAULT_SELECTORS;
    }
    this.crawlConfig.selectLinkOtps = selectLinks;

    if (this.crawlConfig.netIdleWait === -1) {
      if (this.crawlConfig.scopeType === "page" || this.crawlConfig.scopeType === "page-spa") {
        this.crawlConfig.netIdleWait = 15;
      } else {
        this.crawlConfig.netIdleWait = 2;
      }
    }

    const parsedUrl = this.parseUrl(this.url);
    if (!parsedUrl) {
      throw new Error("Invalid URL");
    }
    if (this.crawlConfig.auth || (parsedUrl.username && parsedUrl.password)) {
      this._authEncoded = btoa(
        this.crawlConfig.auth || parsedUrl.username + ":" + parsedUrl.password,
      );
    }
    parsedUrl.username = "";
    parsedUrl.password = "";
    this.url = parsedUrl.href;
    this.crawlConfig.include = parseRx(this.crawlConfig.includeStr);
    this.crawlConfig.exclude = parseRx(this.crawlConfig.excludeStr);

    if (!this.crawlConfig.scopeType) {
      this.crawlConfig.scopeType = this.crawlConfig.include.length ? "custom" : "prefix";
    }

    if (this.crawlConfig.scopeType !== "custom") {
      const [includeNew, allowHashNew] = this.scopeFromType(
        this.crawlConfig.scopeType,
        parsedUrl,
      );
      this.crawlConfig.include = [...includeNew, ...this.crawlConfig.include];
      this.crawlConfig.allowHash = allowHashNew;
    }

    // for page scope, the depth is set to extraHops, as no other
    // crawling is done
    if (this.crawlConfig.scopeType === "page") {
      this.crawlConfig.depth = this.crawlConfig.extraHops;
    }

    this.crawlConfig.sitemap = this.resolveSiteMap(this.crawlConfig.sitemap);
    this.crawlConfig.maxDepth =
      this.crawlConfig.depth < 0 ? MAX_DEPTH : this.crawlConfig.depth;

    this.crawlConfig.proxyServer = await initProxy(this.crawlConfig, RUN_DETACHED);

    if (this.crawlConfig.customBehaviors) {
      this.crawlConfig.customBehaviorsOtps = await this.loadCustomBehaviors(
        this.crawlConfig.customBehaviors as string[],
      );
    }

    this.crawlConfig.headers = { "User-Agent": this.configureUA(browser) };

    let pageLimit = this.crawlConfig.pageLimit;
    if (this.crawlConfig.maxPageLimit) {
      pageLimit = pageLimit
        ? Math.min(pageLimit, this.crawlConfig.maxPageLimit)
        : this.crawlConfig.maxPageLimit;
    }
    this.crawlConfig.pageLimit = pageLimit;

    this.crawlConfig.maxPageTime =
      this.crawlConfig.pageLoadTimeout +
      this.crawlConfig.behaviorTimeout +
      PAGE_OP_TIMEOUT_SECS * 2 +
      this.crawlConfig.pageExtraDelay;

    this.crawlConfig.gotoOpts = {
      waitUntil: this.crawlConfig.waitUntil,
      timeout: this.crawlConfig.pageLoadTimeout * 1000,
    };

    const captureBasePrefix = '';
    this.crawlConfig.adBlockRules = new AdBlockRules(
      captureBasePrefix,
      this.crawlConfig.adBlockMessage,
    );

    if (this.crawlConfig.blockRules && this.crawlConfig.blockRules.length) {
      this.crawlConfig.blockRuleOpts = new BlockRules(
        this.crawlConfig.blockRules as BlockRuleDecl[],
        captureBasePrefix,
        this.crawlConfig.blockMessage,
      );
    }
  }

  async getBrowserOptions() {
    return {
      profileUrl: this.config.params.profile,
      headless: this.config.params.headless,
      emulateDevice: this.crawlConfig.emulateDevice,
      swOpt: this.crawlConfig.serviceWorker,
      chromeOptions: {
        proxy: this.crawlConfig.proxyServer,
        userAgent: this.crawlConfig.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },

      ondisconnect: (err: any) => {
        this.crawlConfig.interrupted = true;
        logger.error(
          "Browser disconnected (crashed?), interrupting crawl",
          err,
          "browser",
        );
        this.crawlConfig.browserCrashed = true;
      },
    } as any;
  }

  extraChromeArgs() {
    const args = [];
    if (this.crawlConfig.lang) {
      args.push(`--accept-lang=${this.crawlConfig.lang}`);
    }
    return args;
  }

  async loadCustomBehaviors(sources: string[]) {
    let str = "";

    for (const { contents } of await collectCustomBehaviors(sources)) {
      str += `self.__bx_behaviors.load(${contents});\n`;
    }

    return str;
  }

  configureUA(browser: Browser) {
    // override userAgent
    if (this.crawlConfig.userAgent) {
      this.crawlConfig.emulateDevice.userAgent = this.crawlConfig.userAgent;
      return this.crawlConfig.userAgent;
    }

    // if device set, it overrides the default Chrome UA
    if (!this.crawlConfig.emulateDevice.userAgent) {
      this.crawlConfig.emulateDevice.userAgent = browser.getDefaultUA();
    }

    // suffix to append to default userAgent
    if (this.crawlConfig.userAgentSuffix) {
      this.crawlConfig.emulateDevice.userAgent += " " + this.crawlConfig.userAgentSuffix;
    }

    return this.crawlConfig.emulateDevice.userAgent;
  }

  authHeader() {
    return this._authEncoded ? "Basic " + this._authEncoded : null;
  }

  newScopedSeed(url: string) {
    return new ScopedSeed({
      url,
      name: this.name,
      dataConfig: this.dataConfig,
      crawlConfig: this.crawlConfig,
      id: this.id,
    }, this.config);
  }

  addExclusion(value: string | RegExp) {
    if (!value) {
      return;
    }
    if (!(value instanceof RegExp)) {
      value = new RegExp(value);
    }
    this.crawlConfig.exclude.push(value);
  }

  removeExclusion(value: string) {
    for (let i = 0; i < this.crawlConfig.exclude.length; i++) {
      if (this.crawlConfig.exclude[i].toString() == value.toString()) {
        this.crawlConfig.exclude.splice(i, 1);
        return true;
      }
    }
  }

  parseUrl(url: string, logDetails = {}) {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url.trim());
    } catch (e) {
      logger.warn("Invalid Page - not a valid URL", { url, ...logDetails });
      return null;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
      logger.warn("Invalid Page - URL must start with http:// or https://", {
        url,
        ...logDetails,
      });
      parsedUrl = null;
    }

    return parsedUrl;
  }

  resolveSiteMap(sitemap: boolean | string | null): string | null {
    if (sitemap === true) {
      return "<detect>";
    } else if (typeof sitemap === "string") {
      return sitemap;
    }

    return null;
  }

  scopeFromType(scopeType: ScopeType, parsedUrl: URL): [RegExp[], boolean] {
    let include: RegExp[] = [];
    let allowHash = false;

    switch (scopeType) {
      case "page":
        include = [];
        break;

      case "page-spa":
        // allow scheme-agnostic URLS as likely redirects
        include = [
          new RegExp("^" + urlRxEscape(parsedUrl.href, parsedUrl) + "#.+"),
        ];
        allowHash = true;
        break;

      case "prefix":
        include = [
          new RegExp(
            "^" +
              urlRxEscape(
                parsedUrl.origin +
                  parsedUrl.pathname.slice(
                    0,
                    parsedUrl.pathname.lastIndexOf("/") + 1,
                  ),
                parsedUrl,
              ),
          ),
        ];
        break;

      case "host":
        include = [
          new RegExp("^" + urlRxEscape(parsedUrl.origin + "/", parsedUrl)),
        ];
        break;

      case "domain":
        if (parsedUrl.hostname.startsWith("www.")) {
          parsedUrl.hostname = parsedUrl.hostname.replace("www.", "");
        }
        include = [
          new RegExp(
            "^" +
              urlRxEscape(parsedUrl.origin + "/", parsedUrl).replace(
                "\\/\\/",
                "\\/\\/([^/]+\\.)*",
              ),
          ),
        ];
        break;

      case "any":
        include = [/.*/];
        break;

      default:
        logger.fatal(
          `Invalid scope type "${scopeType}" specified, valid types are: page, page-spa, prefix, host, domain, any`,
        );
    }

    return [include, allowHash];
  }

  isAtMaxDepth(depth: number, extraHops: number) {
    return depth >= this.crawlConfig.maxDepth && extraHops >= this.crawlConfig.maxExtraHops;
  }

  isIncluded(
    url: string,
    depth: number,
    extraHops = 0,
    logDetails = {},
    noOOS = false,
  ): { url: string; isOOS: boolean } | false {
    const urlParsed = this.parseUrl(url, logDetails);
    if (!urlParsed) {
      return false;
    }

    if (!this.crawlConfig.allowHash) {
      // remove hashtag
      urlParsed.hash = "";
    }

    url = urlParsed.href;

    if (url === this.url) {
      return { url, isOOS: false };
    }

    // skip already crawled
    // if (this.seenList.has(url)) {
    //  return false;
    //}
    let inScope = false;

    // check scopes if depth <= maxDepth
    // if depth exceeds, than always out of scope
    if (depth <= this.crawlConfig.maxDepth) {
      for (const s of this.crawlConfig.include) {
        if (s.test(url)) {
          inScope = true;
          break;
        }
      }
    }

    let isOOS = false;

    if (!inScope) {
      if (!noOOS && this.crawlConfig.maxExtraHops && extraHops <= this.crawlConfig.maxExtraHops) {
        isOOS = true;
      } else {
        //console.log(`Not in scope ${url} ${this.include}`);
        return false;
      }
    }

    // check exclusions
    for (const e of this.crawlConfig.exclude) {
      if (e.test(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return false;
      }
    }

    return { url, isOOS };
  }
}

export function rxEscape(string: string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function urlRxEscape(url: string, parsedUrl: URL) {
  return rxEscape(url).replace(parsedUrl.protocol, "https?:");
}

export function parseRx(
  value: string[] | RegExp[] | string | null | undefined,
) {
  if (value === null || value === undefined || value === "") {
    return [];
  } else if (!(value instanceof Array)) {
    return [new RegExp(value)];
  } else {
    return value.map((e) => (e instanceof RegExp ? e : new RegExp(e)));
  }
}
