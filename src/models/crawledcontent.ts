import mongoose, { Document, Schema } from "mongoose";

// Interface cho Crawled Content
export interface ICrawledContent extends Document {
  sourceId: mongoose.Types.ObjectId; // Tham chiếu đến nguồn
  url: string;
  title: string;
  content: string;
  images: string[];
  status: "pending" | "processed" | "published"; // Trạng thái xử lý
  createdAt: Date;
  updatedAt: Date;
}

// Schema cho Crawled Content
const CrawledContentSchema: Schema = new Schema({
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Source",
    required: true,
  },
  url: { type: String, required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  images: { type: [String], default: [] },
  status: {
    type: String,
    enum: ["pending", "processed", "published"],
    default: "pending",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Xuất Model
export const CrawledContentModel = mongoose.model<ICrawledContent>(
  "CrawledContent",
  CrawledContentSchema,
);
