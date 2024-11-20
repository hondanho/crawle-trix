import mongoose, { Schema, Document } from "mongoose";

// Interface cho Source
export interface ISource extends Document {
  name: string;
  url: string;
  selectors: {
    title: string;
    content: string;
    image?: string;
  };
  schedule: string; // Cron expression
  createdAt: Date;
  updatedAt: Date;
}

// Schema cho Source
const SourceSchema: Schema = new Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },
  selectors: {
    title: { type: String, required: true },
    content: { type: String, required: true },
    image: { type: String, required: false },
  },
  schedule: { type: String, required: true }, // Ví dụ: "0 0 * * *"
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Xuất Model
export const SourceModel = mongoose.model<ISource>("Source", SourceSchema);
