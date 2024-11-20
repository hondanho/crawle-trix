
import connectDB from "./db.js";
import { CrawledContentModel } from "./models/crawledcontent.js";
import { JobModel } from "./models/job.js";
import { SourceModel } from "./models/source.js";

export const seedDatabase = async () => {
  try {
    // Kết nối MongoDB
    await connectDB();
    console.log("Connected to MongoDB");

    // Xóa dữ liệu cũ nếu cần (Tùy chọn)
    await SourceModel.deleteMany({});
    await CrawledContentModel.deleteMany({});
    await JobModel.deleteMany({});
    console.log("Cleared old data");

    // Thêm dữ liệu mẫu cho nguồn crawl
    const sources = await SourceModel.insertMany([
      {
        name: "Example News Source",
        url: "https://example.com/news",
        selectors: {
          title: "h1.article-title",
          content: "div.article-content",
          image: "img.article-image",
        },
        schedule: "0 0 * * *", // Daily crawl
      },
      {
        name: "Tech Blog",
        url: "https://example.com/tech",
        selectors: {
          title: "h2.post-title",
          content: "div.post-body",
          image: "img.feature-image",
        },
        schedule: "0 12 * * *", // Crawl at noon daily
      },
    ]);
    console.log("Seeded sources:", sources);

    // Thêm dữ liệu mẫu cho nội dung đã crawl
    const contents = await CrawledContentModel.insertMany([
      {
        sourceId: sources[0]._id,
        url: "https://example.com/news/article1",
        title: "Example News Article 1",
        content: "This is the content of example news article 1.",
        images: ["https://example.com/images/article1.jpg"],
        status: "pending",
      },
      {
        sourceId: sources[1]._id,
        url: "https://example.com/tech/post1",
        title: "Tech Blog Post 1",
        content: "This is the content of tech blog post 1.",
        images: ["https://example.com/images/post1.jpg"],
        status: "processed",
      },
    ]);
    console.log("Seeded crawled content:", contents);

    // Thêm dữ liệu mẫu cho công việc
    const jobs = await JobModel.insertMany([
      {
        sourceId: sources[0]._id,
        url: "https://example.com/news/article1",
        type: "crawl",
        status: "completed",
      },
      {
        sourceId: sources[1]._id,
        url: "https://example.com/tech/post1",
        type: "process",
        status: "pending",
      },
    ]);
    console.log("Seeded jobs:", jobs);

    console.log("Database seeding completed!");
  } catch (err) {
    console.error("Error seeding database:", err);
  }
};
