import { CrawlerArgs } from "../util/argParser.js";
import path from "path";
import os from "os";
import fsp from "fs/promises";
import fs, { WriteStream } from "fs";
import { HTTPResponse, Page } from "puppeteer-core";
import child_process from "child_process";

import { logger } from "../util/logger.js";
import { PageState } from "../util/state.js";
import { ScopedSeed } from "../util/seeds.js";
import { AdBlockRules } from "../util/blockrules.js";
import { BlockRules } from "../util/blockrules.js";
import { HealthChecker } from "../util/healthcheck.js";
import { OriginOverride } from "../util/originoverride.js";
import { Browser } from "../util/browser.js";
import { Crawler } from "./crawler.js";
import { DISPLAY, PAGE_OP_TIMEOUT_SECS } from "../util/constants.js";
import { collectCustomBehaviors, getInfoString } from "../util/file_reader.js";
import { ChildProcess } from "child_process";
import { initProxy } from "../util/proxy.js";

const RUN_DETACHED = process.env.DETACHED_CHILD_PROC == "1";

export interface CrawlerConfig {
  params: CrawlerArgs;

  collDir: string;
  logDir: string;
  logFilename: string;

  headers: Record<string, string>;

  logFH: WriteStream | null;

  crawlId: string;

  startTime: number;

  limitHit: boolean;
  pageLimit: number;

  saveStateFiles: string[];
  lastSaveTime: number;

  maxPageTime: number;

  resources: { url: string; type: string; response?: HTTPResponse }[];

  seeds: ScopedSeed[];
  numOriginalSeeds: number;

  emulateDevice: Record<string, any>;

  captureBasePrefix: string;

  infoString: string;

  gotoOpts: Record<string, any>;

  archivesDir: string;

  blockRules: BlockRules | null;
  adBlockRules: AdBlockRules | null;

  healthChecker: HealthChecker | null;
  originOverride: OriginOverride | null;

  interrupted: boolean;
  browserCrashed: boolean;
  finalExit: boolean;
  uploadAndDeleteLocal: boolean;
  done: boolean;
  postCrawling: boolean;

  customBehaviors: string;
  behaviorsChecked: boolean;
  behaviorLastLine?: string;

  browser: Browser;

  maxHeapUsed: number;
  maxHeapTotal: number;

  proxyServer?: string;

  driver:
    | ((opts: {
        page: Page;
        data: PageState;
        crawler: Crawler;
      }) => Promise<void>)
    | null;
}

// Quản lý configuration và khởi tạo
export class ConfigManager {
  public config: CrawlerConfig;

  constructor() {
    this.config = null as unknown as CrawlerConfig;
  }

  async initializeConfig(params: CrawlerArgs): Promise<CrawlerConfig> {
    const collection = this.getCollectionName(params);
    const paths = this.initializePaths(params, collection);

    const logFilename = path.join(
      paths.logDir,
      `crawl-${new Date().toISOString().replace(/[^\d]/g, "")}.log`,
    );

    // Tính toán maxPageTime
    const maxPageTime =
      params.pageLoadTimeout +
      params.behaviorTimeout +
      PAGE_OP_TIMEOUT_SECS * 2 +
      params.pageExtraDelay;

    // Tính pageLimit
    let pageLimit = params.pageLimit;
    if (params.maxPageLimit) {
      pageLimit = pageLimit
        ? Math.min(pageLimit, params.maxPageLimit)
        : params.maxPageLimit;
    }

    if (params.overwrite) {
      try {
        fs.rmSync(paths.collDir, { recursive: true, force: true });
      } catch (e) {
        logger.error(`Unable to clear ${paths.collDir}`, e);
      }
    }

    if (!params.headless && !process.env.NO_XVFB) {
      // Chỉ chạy Xvfb trên Linux/Unix
      if (process.platform !== "win32") {
        child_process.spawn(
          "Xvfb",
          [
            DISPLAY,
            "-listen",
            "tcp",
            "-screen",
            "0",
            process.env.GEOMETRY || "",
            "-ac",
            "+extension",
            "RANDR",
          ],
          { detached: RUN_DETACHED },
        );
      }
    }

    this.config = {
      params,

      // Paths
      collDir: paths.collDir,
      logDir: paths.logDir,
      logFilename,
      archivesDir: paths.archivesDir,

      // Headers & crawl info
      headers: {},
      crawlId: process.env.CRAWL_ID || os.hostname(),
      startTime: Date.now(),

      // Limits
      limitHit: false,
      pageLimit,
      maxPageTime,

      // State
      saveStateFiles: [],
      lastSaveTime: 0,

      // Resources
      resources: [],

      // Seeds
      seeds: params.scopedSeeds as ScopedSeed[],
      numOriginalSeeds: (params.scopedSeeds as ScopedSeed[]).length ?? 0,

      // Browser config
      emulateDevice: params.emulateDevice || {},
      gotoOpts: {
        waitUntil: params.waitUntil,
        timeout: params.pageLoadTimeout * 1000,
      },

      // Rules
      blockRules: null,
      adBlockRules: null,

      // Status flags
      interrupted: false,
      browserCrashed: false,
      finalExit: false,
      uploadAndDeleteLocal: false,
      done: false,
      postCrawling: false,

      // Behaviors
      customBehaviors: params.customBehaviors
        ? await this.loadCustomBehaviors(params.customBehaviors as string[])
        : "",
      behaviorsChecked: false,

      // Other
      logFH: null,
      captureBasePrefix: "",
      infoString: "",
      healthChecker: null,
      originOverride: null,
      browser: new Browser(),
      maxHeapUsed: 0,
      maxHeapTotal: 0,
      driver: null,
    };

    this.configureUA(this.config);
    this.config.proxyServer = await initProxy(this.config.params, RUN_DETACHED);

    const subprocesses: ChildProcess[] = [];
    process.on("exit", () => {
      for (const proc of subprocesses) {
        proc.kill();
      }
    });

    return this.config;
  }

  async loadCustomBehaviors(sources: string[]) {
    let str = "";

    for (const { contents } of await collectCustomBehaviors(sources)) {
      str += `self.__bx_behaviors.load(${contents});\n`;
    }

    return str;
  }

  // Tách các phương thức khởi tạo config thành các hàm nhỏ hơn
  private getCollectionName(params: CrawlerArgs): string {
    return (
      params.collection ||
      "crawl-" + new Date().toISOString().slice(0, 19).replace(/[T:-]/g, "")
    );
  }

  public async getBrowserOptions() {
    return {
      profileUrl: this.config.params.profile,
      headless: this.config.params.headless,
      emulateDevice: this.config.emulateDevice,
      swOpt: this.config.params.serviceWorker,
      chromeOptions: {
        proxy: this.config.proxyServer,
        userAgent: this.config.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },

      ondisconnect: (err: any) => {
        this.config.interrupted = true;
        logger.error(
          "Browser disconnected (crashed?), interrupting crawl",
          err,
          "browser",
        );
        this.config.browserCrashed = true;
      },
    } as any;
  }

  extraChromeArgs() {
    const args = [];
    if (this.config.params.lang) {
      args.push(`--accept-lang=${this.config.params.lang}`);
    }
    return args;
  }

  configureUA(config: CrawlerConfig) {
    // override userAgent
    if (config.params.userAgent) {
      config.emulateDevice.userAgent = config.params.userAgent;
      return config.params.userAgent;
    }

    // if device set, it overrides the default Chrome UA
    if (!config.emulateDevice.userAgent) {
      config.emulateDevice.userAgent = config.browser.getDefaultUA();
    }

    // suffix to append to default userAgent
    if (config.params.userAgentSuffix) {
      config.emulateDevice.userAgent += " " + config.params.userAgentSuffix;
    }

    return config.emulateDevice.userAgent;
  }

  private initializePaths(params: CrawlerArgs, collection: string) {
    const cwd = params.cwd || process.cwd();
    const collDir = path.join(cwd, "collections", collection);

    return {
      collDir,
      logDir: path.join(collDir, "logs"),
      archivesDir: path.join(collDir, "archive"),
    };
  }

  async initDirectories(): Promise<void> {
    await fsp.mkdir(this.config.logDir, { recursive: true });
    await fsp.mkdir(this.config.archivesDir, { recursive: true });
    await fsp.mkdir(this.config.collDir, { recursive: true });
  }

  async initLogging(): Promise<void> {
    const logFH = fs.createWriteStream(this.config.logFilename, { flags: "a" });
    logger.setExternalLogStream(logFH);
    logger.setDebugLogging(this.config.params.logging.includes("debug"));
    logger.setLogLevel(this.config.params.logLevel);
    logger.setContext(this.config.params.logContext);
    logger.setExcludeContext(this.config.params.logExcludeContext);
    if (this.config.params.restartsOnError) {
      logger.setDefaultFatalExitCode(0);
    }

    logger.debug("Writing log to: " + this.config.logFilename, {}, "general");

    this.config.infoString = await getInfoString();
    logger.info(this.config.infoString);

    logger.info("Seeds", this.config.params.scopedSeeds);
    logger.info("Link Selectors", this.config.params.selectLinks);

    if (this.config.params.behaviorOpts) {
      logger.info("Behavior Options", this.config.params.behaviorOpts);
    } else {
      logger.info("Behaviors disabled");
    }

    if (this.config.params.profile) {
      logger.info("With Browser Profile", { url: this.config.params.profile });
    }

    if (this.config.params.overwrite) {
      logger.debug(`Clearing ${this.config.collDir} before starting`);
    }

    if (!this.config.params.headless && !process.env.NO_XVFB) {
      // Chỉ chạy Xvfb trên Linux/Unix
      if (process.platform == "win32") {
        logger.debug("Skipping Xvfb on Windows platform");
      }
    }
  }
}
