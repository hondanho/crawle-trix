import connectDB from "./db.js";
import { CrawledContentModel } from "./models/crawledcontent.js";
import { JobModel } from "./models/job.js";
import { SeedModel } from "./models/seed.js";

export const seedDatabase = async () => {
  try {
    // Kết nối MongoDB
    await connectDB();
    console.log("Connected to MongoDB");

    // Xóa dữ liệu cũ nếu cần (Tùy chọn)
    await SeedModel.deleteMany({});
    await CrawledContentModel.deleteMany({});
    await JobModel.deleteMany({});
    console.log("Cleared old data");

    // Thêm dữ liệu mẫu cho nguồn crawl
    const seeds = await SeedModel.insertMany([
      {
        name: "Truyen Sex Crawler",
        url: "https://truyensex.moe",
        dataConfig: {
          title: [
            {
              regex: "h1.entry-title",
            },
            {
              selector: "h1.entry-title",
            },
          ],
          content: [
            {
              selector: "div.entry-content",
            },
          ],
          image: [
            {
              selector: "img.wp-post-image",
            },
          ],
        },
        schedule: "0 */6 * * *",
        crawlConfig: {
          blockAds: true,
          waitUntil: "domcontentloaded",
          originOverride: false,
          setJavaScriptEnabled: true,
          enableBehaviors: false,
          scopeType: "custom",
          limitHit: false,
          pageLimit: 10,
          postLoadDelay: 0,
          excludeStr: [
            "https://truyensex.moe/gioi-thieu/",
            "https://truyensex.moe/gioi-thieu/.*",
            "https://truyensex.moe/quan-tri-huyen/",
            "https://truyensex.moe/quan-tri-huyen/.*",
            "https://truyensex.moe/tag/",
            "https://truyensex.moe/tag/.*",
          ],
          sitemap: null,
          depth: -1,
          includeStr: [
            "https://truyensex.moe/12-nu-than/",
            "https://truyensex.moe/12-nu-than/.*",
          ],
          extraHops: 0,
          auth: null,
          maxExtraHops: 0,
          maxDepth: 0,
          blockRules: null,
          customBehaviors: null,
          behaviorsChecked: false,
          behaviorLastLine: null,
          maxPageTime: 0,
          adBlockRules: null,
          saveAllResources: true,
        },
      },
    ]);
    console.log("Seeded seeds:", seeds);

    // Thêm dữ liệu mẫu cho nội dung đã crawl
    const contents = await CrawledContentModel.insertMany([
      {
        seedId: seeds[0]._id,
        url: "https://example.com/news/article1",
        title: "Example News Article 1",
        content: "This is the content of example news article 1.",
        images: ["https://example.com/images/article1.jpg"],
        status: "pending",
      },
    ]);
    console.log("Seeded crawled content:", contents);

    // Thêm dữ liệu mẫu cho công việc
    const jobs = await JobModel.insertMany([
      {
        seedId: seeds[0]._id,
        url: "https://example.com/news/article1",
        type: "crawl",
        status: "completed",
      },
    ]);
    console.log("Seeded jobs:", jobs);

    console.log("Database seeding completed!");
  } catch (err) {
    console.error("Error seeding database:", err);
  }
};
