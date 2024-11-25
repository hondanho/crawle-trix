import { HTTPResponse, Page } from "puppeteer-core";
import { Resource } from "./storage";

// Thêm method mới để xử lý CSS
async function extractCSSLinks(
  resources: { url: string; type: string; response?: HTTPResponse }[],
) {
  // Lọc ra các CSS resources
  const cssResources = resources.filter((r) => r.type === "stylesheet");

  for (const cssResource of cssResources) {
    try {
      // Fetch nội dung CSS
      const response = await fetch(cssResource.url);
      const content = await response.text();

      // Tìm tất cả URLs trong CSS
      const cssUrls = extractUrlsFromCSS(content, cssResource.url);

      // Thêm URLs tìm được vào resources
      cssUrls.forEach((url) => {
        if (!resources.find((r) => r.url === url)) {
          resources.push({
            url,
            type: getCSSResourceType(url),
            response: cssResource.response,
          });
        }
      });
    } catch (e) {
      // Bỏ qua lỗi
    }
  }

  return resources;
}

// Helper method để trích xuất URLs từ CSS text
function extractUrlsFromCSS(cssText: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  // Regex để tìm URLs trong CSS
  const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
  const importRegex = /@import\s+['"]([^'"]+)['"]/g;

  // Tìm tất cả url()
  let match;
  while ((match = urlRegex.exec(cssText)) !== null) {
    try {
      const url = new URL(match[1], baseUrl).href;
      urls.add(url);
    } catch (e) {
      // Bỏ qua URLs không hợp lệ
    }
  }

  // Tìm tất cả @import
  while ((match = importRegex.exec(cssText)) !== null) {
    try {
      const url = new URL(match[1], baseUrl).href;
      urls.add(url);
    } catch (e) {
      // Bỏ qua URLs không hợp lệ
    }
  }

  return Array.from(urls);
}

// Helper method để xác định loại tài nguyên từ URL
function getCSSResourceType(url: string): string {
  const extension = url.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return "image";
    case "woff":
    case "woff2":
    case "ttf":
    case "eot":
      return "font";
    case "css":
      return "stylesheet";
    default:
      return "other";
  }
}

export async function collectLinkAssets(
  resources: Resource[],
  page: Page,
  originDomain: string,
) {
  const newResources = await page.evaluate((domain) => {
    const allResources = new Set<{
      url: string;
      type: string;
      response?: HTTPResponse;
    }>();

    // Thu thập URLs từ thẻ <style> in document
    document.querySelectorAll("style").forEach((styleTag) => {
      const styleContent = styleTag.textContent;
      if (styleContent) {
        const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
        let match;
        while ((match = urlRegex.exec(styleContent)) !== null) {
          try {
            const url = new URL(match[1], window.location.href);
            if (url.origin === domain) {
              allResources.add({ url: url.href, type: "image" });
            }
          } catch (e) {
            // Bỏ qua URL không hợp lệ
          }
        }
      }
    });

    // Thu thập images
    document.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src");
      if (src) {
        try {
          const url = new URL(src, window.location.href);
          if (url.origin === domain) {
            allResources.add({ url: url.href, type: "image" });
          }
        } catch (e) {
          // Bỏ qua URL không hợp lệ
        }
      }
    });

    // Thu thập CSS
    document.querySelectorAll('link[rel="stylesheet"]').forEach((css) => {
      const href = css.getAttribute("href");
      if (href) {
        try {
          const url = new URL(href, window.location.href);
          if (url.origin === domain) {
            allResources.add({ url: url.href, type: "stylesheet" });
          }
        } catch (e) {
          // Bỏ qua URL không hợp lệ
        }
      }
    });

    // Thu thập JavaScript
    document.querySelectorAll("script[src]").forEach((script) => {
      const src = script.getAttribute("src");
      if (src) {
        try {
          const url = new URL(src, window.location.href);
          if (url.origin === domain) {
            allResources.add({ url: url.href, type: "script" });
          }
        } catch (e) {
          // Bỏ qua URL không hợp lệ
        }
      }
    });

    return Array.from(allResources);
  }, originDomain);

  // Thêm vào mảng resources
  newResources.forEach((resource) => {
    if (!resources.find((r) => r.url === resource.url)) {
      resources.push({
        url: resource.url,
        type: resource.type,
        response: undefined,
      });
    }
  });

  // Thu thập links từ CSS files
  const cssLinkImages = await extractCSSLinks(resources);

  // Merge cssLinkImages and resources
  cssLinkImages.forEach((cssLinkImage) => {
    if (!resources.find((r) => r.url === cssLinkImage.url)) {
      resources.push(cssLinkImage);
    }
  });

  const uniqueResources = new Map<
    string,
    { url: string; type: string; response?: HTTPResponse }
  >();

  const allResources = [...resources, ...cssLinkImages];
  for (const resource of allResources) {
    const existingResource = uniqueResources.get(resource.url);

    if (!existingResource) {
      // Nếu URL chưa tồn tại, thêm vào map
      uniqueResources.set(resource.url, resource);
    } else if (!existingResource.response && resource.response) {
      // Ưu tiên resource có response
      uniqueResources.set(resource.url, resource);
    }
  }

  return Array.from(uniqueResources.values());
}
