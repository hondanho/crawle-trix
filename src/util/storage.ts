import child_process from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import util from "util";
import path from "path";

import os from "os";
import { createHash } from "crypto";

import * as Minio from "minio";

import { logger } from "./logger.js";

// @ts-expect-error (incorrect types on get-folder-size)
import getFolderSize from "get-folder-size";

import { HTTPResponse, Page } from "puppeteer-core";
import { collectLinkAssets } from "./dom.js";

const DEFAULT_REGION = "us-east-1";

// ===========================================================================
export class S3StorageSync {
  fullPrefix: string;
  client: Minio.Client;

  bucketName: string;
  objectPrefix: string;
  resources: object[] = [];

  userId: string;
  crawlId: string;
  webhookUrl?: string;

  // TODO: Fix this the next time the file is edited.

  constructor(
    urlOrData: string | any,
    {
      webhookUrl,
      userId,
      crawlId,
    }: { webhookUrl?: string; userId: string; crawlId: string },
  ) {
    let url;
    let accessKey;
    let secretKey;

    if (typeof urlOrData === "string") {
      url = new URL(urlOrData);
      accessKey = url.username;
      secretKey = url.password;
      url.username = "";
      url.password = "";
      this.fullPrefix = url.href;
    } else {
      url = new URL(urlOrData.endpointUrl);
      accessKey = urlOrData.accessKey;
      secretKey = urlOrData.secretKey;
      this.fullPrefix = url.href;
    }

    const region = process.env.STORE_REGION || DEFAULT_REGION;

    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
      partSize: 100 * 1024 * 1024,
      region,
    });

    this.bucketName = url.pathname.slice(1).split("/")[0];

    this.objectPrefix = url.pathname.slice(this.bucketName.length + 2);

    this.resources = [];

    this.userId = userId;
    this.crawlId = crawlId;
    this.webhookUrl = webhookUrl;
  }

  async uploadFile(srcFilename: string, targetFilename: string) {
    const fileUploadInfo = {
      bucket: this.bucketName,
      crawlId: this.crawlId,
      prefix: this.objectPrefix,
      targetFilename,
    };
    logger.info("S3 file upload information", fileUploadInfo, "storage");

    await this.client.fPutObject(
      this.bucketName,
      this.objectPrefix + targetFilename,
      srcFilename,
    );

    const hash = await checksumFile("sha256", srcFilename);
    const path = targetFilename;

    const size = await getFileSize(srcFilename);

    // for backwards compatibility, keep 'bytes'
    return { path, size, hash, bytes: size };
  }

  async downloadFile(srcFilename: string, destFilename: string) {
    await this.client.fGetObject(
      this.bucketName,
      this.objectPrefix + srcFilename,
      destFilename,
    );
  }
}

export function initStorage() {
  if (!process.env.STORE_ENDPOINT_URL) {
    return null;
  }

  const endpointUrl =
    process.env.STORE_ENDPOINT_URL + (process.env.STORE_PATH || "");
  const storeInfo = {
    endpointUrl,
    accessKey: process.env.STORE_ACCESS_KEY,
    secretKey: process.env.STORE_SECRET_KEY,
  };

  const opts = {
    crawlId: process.env.CRAWL_ID || os.hostname(),
    webhookUrl: process.env.WEBHOOK_URL || "",
    userId: process.env.STORE_USER || "",
  };

  logger.info("Initing Storage...");
  return new S3StorageSync(storeInfo, opts);
}

export async function getFileSize(filename: string) {
  const stats = await fsp.stat(filename);
  return stats.size;
}

export async function getDirSize(dir: string): Promise<number> {
  const { size, errors } = await getFolderSize(dir);
  if (errors && errors.length) {
    logger.warn("Size check errors", { errors }, "storage");
  }
  return size;
}

export async function checkDiskUtilization(
  collDir: string,
  // TODO: Fix this the next time the file is edited.

  params: Record<string, any>,
  archiveDirSize: number,
  dfOutput = null,
  doLog = true,
) {
  const diskUsage: Record<string, string> = await getDiskUsage(
    collDir,
    dfOutput,
  );
  const usedPercentage = parseInt(diskUsage["Use%"].slice(0, -1));

  // Check that disk usage isn't already above threshold
  if (usedPercentage >= params.diskUtilization) {
    if (doLog) {
      logger.info(
        `Disk utilization threshold reached ${usedPercentage}% > ${params.diskUtilization}%, stopping`,
      );
    }
    return {
      stop: true,
      used: usedPercentage,
      projected: null,
      threshold: params.diskUtilization,
    };
  }

  // Check that disk usage isn't likely to cross threshold
  const kbUsed = parseInt(diskUsage["Used"]);
  const kbTotal = parseInt(diskUsage["1K-blocks"]);

  let kbArchiveDirSize = Math.round(archiveDirSize / 1024);

  // assume if has STORE_ENDPOINT_URL, will be uploading to remote
  // and not storing local copy of either WACZ or WARC
  if (!process.env.STORE_ENDPOINT_URL) {
    if (params.combineWARC && params.generateWACZ) {
      kbArchiveDirSize *= 4;
    } else if (params.combineWARC || params.generateWACZ) {
      kbArchiveDirSize *= 2;
    }
  }

  const projectedTotal = kbUsed + kbArchiveDirSize;
  const projectedUsedPercentage = calculatePercentageUsed(
    projectedTotal,
    kbTotal,
  );

  if (projectedUsedPercentage >= params.diskUtilization) {
    if (doLog) {
      logger.info(
        `Disk utilization projected to reach threshold ${projectedUsedPercentage}% > ${params.diskUtilization}%, stopping`,
      );
    }
    return {
      stop: true,
      used: usedPercentage,
      projected: projectedUsedPercentage,
      threshold: params.diskUtilization,
    };
  }

  return {
    stop: false,
    used: usedPercentage,
    projected: projectedUsedPercentage,
    threshold: params.diskUtilization,
  };
}

export async function getDFOutput(path: string) {
  const exec = util.promisify(child_process.exec);

  if (process.platform === "win32") {
    const drive = path.split(":")[0];
    const cmd = `powershell -command "$vol = Get-Volume ${drive}; [math]::Round($vol.Size/1024), [math]::Round($vol.SizeRemaining/1024)"`;
    try {
      const { stdout } = await exec(cmd);
      const [total, free] = stdout
        .trim()
        .split("\n")
        .map((n) => parseInt(n));
      const used = total - free;
      const usedPercent = Math.round((used / total) * 100);

      return `Filesystem 1K-blocks Used Available Use% Mounted\n${drive}: ${total} ${used} ${free} ${usedPercent}% ${drive}:\\`;
    } catch (error) {
      logger.warn("Error getting disk info", { error });
      // Trả về giá trị mặc định nếu có lỗi
      return `Filesystem 1K-blocks Used Available Use% Mounted\n${drive}: 0 0 0 0% ${drive}:\\`;
    }
  }

  const { stdout } = await exec(`df ${path}`);
  return stdout;
}

export async function getDiskUsage(path = "/crawls", dfOutput = null) {
  const result = dfOutput || (await getDFOutput(path));
  const lines = result.split("\n");
  const keys = lines[0].split(/\s+/gi);
  const rows = lines.slice(1).map((line) => {
    const values = line.split(/\s+/gi);
    // TODO: Fix this the next time the file is edited.

    return keys.reduce((o: Record<string, any>, k, index) => {
      o[k] = values[index];
      return o;
    }, {});
  });
  return rows[0];
}

export function calculatePercentageUsed(used: number, total: number) {
  return Math.round((used / total) * 100);
}

function checksumFile(hashName: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);

    const stream = fs.createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export type Resource = { url: string; type: string; response?: HTTPResponse };

export async function downloadAllResources(
  page: Page,
  resourceOlds: Resource[],
  originDomain: string,

  archivesDir: string,
) {
  // Collect assets
  const resources = await collectLinkAssets(resourceOlds, page, originDomain);

  // Sau khi page load xong, lưu các resource
  const missingLinks = resources.filter((rp) => !rp.response);

  // Tải song song các resources
  const downloadPromises = resources.map(async (resource) => {
    if (resource.response) {
      try {
        const buffer = await resource.response.buffer();
        return downloadResource(buffer, resource.url, archivesDir);
      } catch (err) {
        return downloadResourceFromUrl(resource.url, archivesDir);
      }
    }
  });

  // Tải song song các missing links
  const missingDownloadPromises = missingLinks.map((link) =>
    downloadResourceFromUrl(link.url, archivesDir),
  );

  await Promise.all([...downloadPromises, ...missingDownloadPromises]);

  // Trả về thống kê
  return {
    totalResources: resources.length + missingLinks.length,
    downloadedFromResponse: resources.filter((r) => r.response).length,
    additionalDownloaded: missingLinks.length,
  };
}

async function shouldWriteFile(fullPath: string): Promise<boolean> {
  return !(await fsp
    .access(fullPath)
    .then(() => true)
    .catch(() => false));
}

function getResourcePath(url: string): string {
  const resourceUrl = new URL(url);
  let urlPath = resourceUrl.pathname;

  if (urlPath.startsWith("/")) {
    urlPath = urlPath.slice(1);
  }

  if (!urlPath || urlPath.endsWith("/")) {
    urlPath += "index.html";
  }

  return urlPath;
}

export async function downloadResource(
  buffer: Buffer,
  url: string,
  archivesDir: string,
) {
  try {
    if (url.startsWith("data:")) {
      return; // Bỏ qua nếu là URL kiểu data
    }

    const urlPath = getResourcePath(url);
    const fullPath = path.join(archivesDir, urlPath);

    await fsp.mkdir(path.dirname(fullPath), { recursive: true });

    // Kiểm tra file đã tồn tại chưa
    if (await shouldWriteFile(fullPath)) {
      // Chỉ ghi file nếu chưa tồn tại
      await fsp.writeFile(fullPath, buffer);

      logger.info("Đã lưu resource thành công", {
        url,
        path: fullPath,
        size: buffer.length,
      });
    } else {
      logger.info("Resource đã tồn tại, bỏ qua", {
        url,
        path: fullPath,
      });
    }

    return {
      success: true,
      path: fullPath,
      size: buffer.length,
    };
  } catch (err) {
    logger.error("Lỗi khi lưu resource", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Thêm phương thức mới để tải và lưu resources
export async function downloadResourceFromUrl(
  url: string,
  archivesDir: string,
) {
  try {
    if (url.startsWith("data:")) {
      return; // Bỏ qua nếu là URL kiểu data
    }

    const urlPath = getResourcePath(url);
    const fullPath = path.join(archivesDir, urlPath);

    await fsp.mkdir(path.dirname(fullPath), { recursive: true });

    // Thêm headers cần thiết
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      Referer: new URL(url).origin,
    };

    // Thực hiện fetch request
    const response = await fetch(url, { headers });
    const buffer = Buffer.from(await response.arrayBuffer());

    await fsp.mkdir(path.dirname(fullPath), { recursive: true });

    // Kiểm tra file đã tồn tại chưa
    if (await shouldWriteFile(fullPath)) {
      // Chỉ ghi file nếu chưa tồn tại
      await fsp.writeFile(fullPath, buffer);

      logger.info("Đã lưu resource thành công", {
        url,
        path: fullPath,
        size: buffer.length,
      });
    } else {
      logger.info("Resource đã tồn tại, bỏ qua", {
        url,
        path: fullPath,
      });
    }

    return {
      success: true,
      path: fullPath,
      size: buffer.byteLength,
    };
  } catch (err) {
    logger.error("Lỗi khi tải và lưu resource", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function interpolateFilename(filename: string, crawlId: string) {
  filename = filename.replace(
    "@ts",
    new Date().toISOString().replace(/[:TZz.-]/g, ""),
  );
  filename = filename.replace("@hostname", os.hostname());
  filename = filename.replace("@hostsuffix", os.hostname().slice(-14));
  filename = filename.replace("@id", crawlId);
  filename = filename.replaceAll(" ", "_");
  return filename;
}
