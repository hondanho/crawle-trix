import mongoose, { Schema, Document } from "mongoose";
import { ScopeType } from "../util/seeds";
import { BlockRuleDecl } from "../util/blockrules";

// Interface cho Seed
export interface ISeedConfig {
  blockAds: boolean;
  waitUntil: string;
  originOverride: boolean;
  setJavaScriptEnabled: boolean;
  enableBehaviors: boolean;
  scopeType: ScopeType;
  limitHit: boolean;
  pageLimit: number;
  postLoadDelay: number;
  excludeStr: string[];
  sitemap: string | null;
  depth: number;
  includeStr: string[];
  extraHops: number;
  auth: string | null;
  maxExtraHops: number;
  maxDepth: number;
  blockRules: BlockRuleDecl[] | null;
  customBehaviors: string[];
  behaviorsChecked: boolean;
  behaviorLastLine: string | null;
  maxPageTime: number;
  allowHash: boolean;
  pageLoadTimeout: number;
  behaviorTimeout: number;
  pageExtraDelay: number;
  saveAllResources: boolean;
  maxPageLimit: number;
  selectLinks: string[];
  sitemapFromDate: string | null;
  sitemapToDate: string | null;
  behaviors: string[];
  dedupPolicy: string;
  adBlockMessage: string;
  blockMessage: string;
  overwrite: boolean;
  waitOnDone: boolean;
  netIdleWait: number;
  lang: string;
  restartOnError: boolean;
  serviceWorker: string;
  proxyServer: string | null | undefined;
  recrawlUpdateData: boolean;
  schedule: string;
  mobileDevice: string;
  userAgent: string;
  userAgentSuffix: string;
  useSitemap: boolean;
  automated: boolean;
  interactive: boolean;
  windowSize: string;
  cookieDays: number;
  sshProxyPrivateKeyFile: string;
  sshProxyKnownHostsFile: string;
  restartsOnError: boolean;
  interrupted: boolean;
}

export interface IDataSelector {
  regex?: string;
  selector?: string;
}

export interface ISeedDataConfig {
  title: IDataSelector[];
  content: IDataSelector[];
  image: IDataSelector[];
}

export interface ISeed {
  id: string;
  name: string;
  url: string;
  dataConfig: ISeedDataConfig;
  crawlConfig: ISeedConfig;
  createdAt?: Date;
  updatedAt?: Date;
}

// Schema cho Seed
const SeedSchema: Schema = new Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },
  dataConfig: {
    title: [
      {
        regex: { type: String, required: false },
        selector: { type: String, required: false },
      },
    ],
    content: [
      {
        regex: { type: String, required: false },
        selector: { type: String, required: false },
      },
    ],
    image: [
      {
        regex: { type: String, required: false },
        selector: { type: String, required: false },
      },
    ],
  },
  crawlConfig: {
    blockAds: { type: Boolean, required: true, default: true },
    waitUntil: { type: String, required: true, default: "domcontentloaded" },
    setJavaScriptEnabled: { type: Boolean, required: true, default: true },
    enableBehaviors: { type: Boolean, required: true, default: false },
    allowHash: { type: Boolean, required: true, default: false },
    originOverride: { type: Boolean, required: true, default: true },
    scopeType: { type: String, required: true, default: "any" },
    pageLimit: { type: Number, required: true, default: 0 },
    excludeStr: [{ type: String }],
    includeStr: [{ type: String }],
    extraHops: { type: Number, required: true, default: 0 },
    postLoadDelay: { type: Number, required: true, default: 0 },
    auth: { type: String, required: false },
    blockRules: [{ type: Object }],
    limitHit: { type: Boolean, required: true, default: false },
    sitemap: { type: String, required: false, default: null },
    depth: { type: Number, required: true, default: -1 },
    maxExtraHops: { type: Number, required: true, default: 0 },
    maxDepth: { type: Number, required: true, default: 0 },
    customBehaviors: [{ type: String }],
    behaviorsChecked: { type: Boolean, required: true, default: false },
    behaviorLastLine: { type: String, required: false, default: null },
    maxPageTime: { type: Number, required: true, default: 0 },
    pageLoadTimeout: { type: Number, required: true, default: 90 },
    behaviorTimeout: { type: Number, required: true, default: 90 },
    pageExtraDelay: { type: Number, required: true, default: 0 },
    saveAllResources: { type: Boolean, required: true, default: false },
    maxPageLimit: { type: Number, required: true, default: 0 },
    selectLinks: [{ type: String }],
    sitemapFromDate: { type: String, required: false, default: null },
    sitemapToDate: { type: String, required: false, default: null },
    behaviors: [{ type: String }],
    dedupPolicy: { type: String, required: true, default: "skip" },
    adBlockMessage: {
      type: String,
      required: true,
      default: "Blocked by AdBlock rules",
    },
    blockMessage: {
      type: String,
      required: true,
      default: "Blocked by Block rules",
    },
    overwrite: { type: Boolean, required: true, default: false },
    waitOnDone: { type: Boolean, required: true, default: false },
    netIdleWait: { type: Number, required: true, default: -1 },
    lang: { type: String, required: true, default: "vi" },
    restartOnError: { type: Boolean, required: true, default: false },
    serviceWorker: { type: String, required: false, default: null },
    proxyServer: { type: String, required: false, default: null },
    recrawlUpdateData: { type: Boolean, required: true, default: false },
    schedule: { type: String, required: false },
    mobileDevice: { type: String, required: false },
    emulateDevice: { type: String, required: false },
    userAgent: { type: String, required: false },
    userAgentSuffix: { type: String, required: false },
    useSitemap: { type: Boolean, required: true, default: false },
    automated: { type: Boolean, required: true, default: false },
    interactive: { type: Boolean, required: true, default: false },
    windowSize: { type: String, required: false },
    cookieDays: { type: Number, required: true, default: 0 },
    sshProxyPrivateKeyFile: { type: String, required: false },
    sshProxyKnownHostsFile: { type: String, required: false },
    restartsOnError: { type: Boolean, required: true, default: false },
    interrupted: { type: Boolean, required: true, default: false },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Xuất Model
export const SeedModel = mongoose.model<ISeed & Document>("Seed", SeedSchema);
