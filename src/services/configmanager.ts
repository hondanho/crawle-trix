import { CrawlerArgs, parseArgs } from "../util/argParser.js";
import path from "path";
import fsp from "fs/promises";
import fs, { WriteStream } from "fs";
import { Page } from "puppeteer-core";
import child_process from "child_process";

import { logger } from "../util/logger.js";
import { PageState } from "../util/state.js";
import { HealthChecker } from "../util/healthcheck.js";
import { OriginOverride } from "../util/originoverride.js";
import { Crawler } from "./crawler.js";
import { DISPLAY } from "../util/constants.js";
import { getInfoString } from "../util/file_reader.js";
import { ChildProcess } from "child_process";

const RUN_DETACHED = process.env.DETACHED_CHILD_PROC == "1";

export interface CrawlerConfig {
  params: CrawlerArgs;

  collDir: string;
  logDir: string;
  logFilename: string;

  logFH: WriteStream | null;

  startTime: number;

  saveStateFiles: string[];
  lastSaveTime: number;

  infoString: string;

  archivesDir: string;

  healthChecker: HealthChecker | null;
  originOverride: OriginOverride | null;

  finalExit: boolean;
  uploadAndDeleteLocal: boolean;
  done: boolean;
  postCrawling: boolean;

  maxHeapUsed: number;
  maxHeapTotal: number;

  driver:
    | ((opts: {
        page: Page;
        data: PageState;
        crawler: Crawler;
      }) => Promise<void>)
    | null;
}

export class ConfigManager {
  public config: CrawlerConfig;

  constructor() {
    this.config = null as unknown as CrawlerConfig;
  }

  async initializeConfig(params: CrawlerArgs): Promise<CrawlerConfig> {
    // global config
    const collection = this.getCollectionName(params);
    const paths = this.initializePaths(params, collection);
    const logFilename = path.join(
      paths.logDir,
      `crawl-${new Date().toISOString().replace(/[^\d]/g, "")}.log`,
    );

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

      startTime: Date.now(),

      // State
      saveStateFiles: [],
      lastSaveTime: 0,

      finalExit: false,
      uploadAndDeleteLocal: false,
      done: false,
      postCrawling: false,

      // Other
      logFH: null,
      infoString: "",
      healthChecker: null,
      originOverride: null,
      maxHeapUsed: 0,
      maxHeapTotal: 0,
      driver: null,
    };

    const subprocesses: ChildProcess[] = [];
    process.on("exit", () => {
      for (const proc of subprocesses) {
        proc.kill();
      }
    });

    return this.config;
  }

  async init() {
    const params = parseArgs() as CrawlerArgs;
    await this.initializeConfig(params);
    await this.initDirectories();
    await this.initLogging();
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

  private async initDirectories(): Promise<void> {
    await fsp.mkdir(this.config.logDir, { recursive: true });
    await fsp.mkdir(this.config.archivesDir, { recursive: true });
    await fsp.mkdir(this.config.collDir, { recursive: true });
  }

  private async initLogging(): Promise<void> {
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

    // logger.info("Seeds", this.config.params.scopedSeeds);
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

  private getCollectionName(params: CrawlerArgs): string {
    return (
      params.collection ||
      "crawl-" + new Date().toISOString().slice(0, 19).replace(/[T:-]/g, "")
    );
  }
}
