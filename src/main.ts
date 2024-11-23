#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./services/crawler.js";
import connectDB from "./db.js";
import { seedDatabase } from "./seeddata.js";
import dotenv from "dotenv";

let crawler: Crawler | null = null;

let lastSigInt = 0;
let forceTerm = false;
dotenv.config();

async function handleTerminate(signame: string) {
  logger.info(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    logger.error("error: no crawler running, exiting");
    process.exit(1);
  }

  if (await crawler.crawlState.isFinished()) {
    logger.info("success: crawler done, exiting");
    process.exit(0);
  }

  setExitOnRedisError();

  try {
    await crawler.checkCanceled();

    if (!crawler.interrupted) {
      logger.info("SIGNAL: gracefully finishing current pages...");
      crawler.gracefulFinishOnInterrupt();
    } else if (forceTerm || Date.now() - lastSigInt > 200) {
      logger.info("SIGNAL: stopping crawl now...");
      await crawler.setStatusAndExit(0, "canceled");
    }
    lastSigInt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    logger.error("Error stopping crawl after receiving termination signal", e);
  }
}

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  logger.info("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
  forceTerm = true;
});

// init database
await connectDB();
await seedDatabase();
// await scheduleJobs();

crawler = new Crawler();
await crawler.run();
