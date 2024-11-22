import mongoose, { Document, Schema } from "mongoose";

// Interface cho Job
export interface IJob extends Document {
  sourceId: mongoose.Types.ObjectId; // Tham chiếu đến nguồn
  url: string; // URL cần xử lý
  type: "crawl" | "process" | "publish"; // Loại công việc
  status: "pending" | "in_progress" | "completed" | "failed"; // Trạng thái công việc
  createdAt: Date;
  updatedAt: Date;
}

// Schema cho Job
const JobSchema: Schema = new Schema({
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Source",
    required: true,
  },
  url: { type: String, required: true },
  type: { type: String, enum: ["crawl", "process", "publish"], required: true },
  status: {
    type: String,
    enum: ["pending", "in_progress", "completed", "failed"],
    default: "pending",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Xuất Model
export const JobModel = mongoose.model<IJob>("Job", JobSchema);
