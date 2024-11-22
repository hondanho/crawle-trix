// import cron from "node-cron";
// import { SourceModel } from "../models/source.js";
// import { Crawler } from "./crawler.js";

// const scheduleJobs = async () => {
//   try {
//     // Lấy danh sách nguồn từ database
//     const sources = await SourceModel.find();

//     // Duyệt qua từng nguồn để lên lịch
//     sources.forEach((source) => {
//       const { name, schedule } = source;

//       // Kiểm tra định dạng lịch trình
//       if (!cron.validate(schedule)) {
//         console.error(`Invalid schedule format for source: ${name}`);
//         return;
//       }

//       // Lên lịch công việc crawl
//       cron.schedule(schedule, async () => {
//         console.log(`Running job for source: ${name}`);
//         try {
//           // Khởi động các service khác
//           console.log("Database connected. Starting services...");
//           const crawler = new Crawler();

//           await crawler.run();

//           console.log(`Job completed for source: ${name}`);
//         } catch (err) {
//           console.error(`Error running job for source: ${name}`, err);
//         }
//       });

//       console.log(
//         `Scheduled job for source: ${name} with schedule: ${schedule}`,
//       );
//     });
//   } catch (err) {
//     console.error("Error scheduling jobs:", err);
//   }
// };

// export default scheduleJobs;
