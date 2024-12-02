#!/usr/bin/env -S node --experimental-global-webcrypto

import dotenv from "dotenv";

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./services/crawler.js";
import connectDB from "./db.js";
import { seedDatabase } from "./seeddata.js";
import { SeedModel } from "./models/seed.js";
import { ScopedSeed } from "./util/seeds.js";
import { ConfigManager } from "./services/configmanager.js";

dotenv.config();

async function handleTerminate(signame: string) {
  logger.info("SIGINT received, will force immediate exit on SIGTERM/SIGINT");
  logger.info(signame);
  setExitOnRedisError();
}

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  logger.info("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
  // forceTerm = true;
});

// init database
await connectDB();
await seedDatabase();
// await scheduleJobs();

// init config global
const configManager = new ConfigManager();
await configManager.init();
const config = configManager.config;

// init seed
const seedModel = await SeedModel.findOne();
if (seedModel) {
  const scopedSeed = new ScopedSeed({
    id: seedModel.id.toString(),
    url: seedModel.url,
    name: seedModel.name,
    dataConfig: seedModel.dataConfig,
    crawlConfig: seedModel.crawlConfig,
  }, config);

  const crawler = new Crawler(scopedSeed);
  await crawler.init();
  await crawler.crawl();
}
