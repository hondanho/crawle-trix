import { Schema, model } from "mongoose";

const CrawledUrlSchema = new Schema(
  {
    seedId: { type: Schema.Types.ObjectId, ref: "Seed", required: true },
    url: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processed", "failed"],
      default: "pending",
    },
    crawledAt: { type: Date },
  },
  { timestamps: true },
);

export const CrawledUrlModel = model("CrawledUrl", CrawledUrlSchema);
