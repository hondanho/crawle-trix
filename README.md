# Crawlertrix

Crawlertrix is a standalone, high-fidelity, browser-based web crawling system. It is designed to run complex, customizable browser-based crawls in a single Docker container, using [Puppeteer](https://github.com/puppeteer/puppeteer) to control [Brave Browser](https://brave.com/) windows in parallel. Data is captured through the [Chrome Devtools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/).

- **Website:** [Crawlertrix Documentation](https://crawler.docs.browsertrix.com)
- **Docker Hub:** [webrecorder/crawlertrix](https://hub.docker.com/r/webrecorder/crawlertrix)
- **GitHub:** [webrecorder/crawlertrix](https://github.com/webrecorder/crawlertrix)

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Command-Line Usage](#command-line-usage)
- [YAML Configuration](#yaml-configuration)
- [Advanced Options](#advanced-options)
- [Development](#development)
- [Support](#support)
- [License](#license)

---

## Features

- **Single-container, browser-based crawling** with headless/headful browser, running pages in multiple windows.
- **Custom browser behaviors** (autoscroll, video autoplay, site-specific) via [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors).
- **YAML-based configuration** (file or stdin).
- **Seed lists and per-seed scoping rules**.
- **URL blocking** (by regex, iframe, or content).
- **Screencasting**: Watch crawling in real-time.
- **Screenshotting**: Thumbnails, full-page, or viewport screenshots.
- **Optimized capture** of non-HTML resources.
- **Extensible Puppeteer driver** for custom crawl/page logic.
- **Browser profile management**: Create/reuse profiles, automated login.
- **Multi-platform Docker images** (Intel/AMD, Apple Silicon).
- **Quality Assurance (QA) crawling**: Compare live vs. replayed crawl.
- **S3-compatible upload and webhook notification** for crawl outputs.

---

## Architecture

```mermaid
flowchart TD
    A[CLI / Docker Entrypoint] --> B[ConfigManager: Loads CLI/YAML config]
    B --> C[SeedManager: Loads seeds & scoping rules]
    C --> D[Crawler: Orchestrates crawl]
    D --> E[Browser (Brave via Puppeteer)]
    D --> F[StateManager: Tracks crawl state]
    D --> G[PageManager: Handles page navigation]
    D --> H[DataCrawler: Captures resources]
    D --> I[URLExtractor: Finds new links]
    D --> J[Logger: Logs & stats]
    D --> K[Output: WARCs, WACZ, screenshots, logs]
```

- **ConfigManager**: Parses CLI args/YAML, sets up directories, logging, and crawl parameters.
- **SeedManager**: Loads initial URLs ("seeds") and per-seed options.
- **Crawler**: Main orchestrator, manages browser workers, state, and crawl flow.
- **Browser**: Controlled via Puppeteer, runs Brave in parallel windows.
- **StateManager**: Tracks progress, supports interruption/resume.
- **PageManager**: Handles navigation, timeouts, and error handling.
- **DataCrawler**: Captures page content and resources, applies blocking rules.
- **URLExtractor**: Extracts new URLs from crawled pages.
- **Logger**: Structured logging, stats, and error reporting.
- **Output**: Archives (WARC/WACZ), screenshots, logs, and optional S3 upload.

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed.

### Basic Crawl

```sh
docker pull webrecorder/crawlertrix
docker run -v $PWD/crawls:/crawls/ -it webrecorder/crawlertrix crawl --url https://example.com --generateWACZ --text --collection test
```

- Output WACZ will be in `crawls/collection/test/test.wacz`.
- Open the WACZ in [ReplayWeb.page](https://replayweb.page) to browse your archive.

---

## Command-Line Usage

Crawlertrix is primarily used via Docker. Common options:

```sh
docker run -v $PWD/crawls:/crawls/ webrecorder/crawlertrix crawl [OPTIONS]
```

### Common Options

- `--url [URL]` : Seed URL(s) to crawl.
- `--seedFile [file]` : File with one seed URL per line.
- `--workers N` : Number of parallel browser workers.
- `--limit N` : Max number of pages to crawl.
- `--collection NAME` : Output collection name.
- `--overwrite` : Overwrite existing collection directory.
- `--text` : Extract text for full-text search.
- `--screenshot [view,fullPage,thumbnail]` : Take screenshots.
- `--blockAds` : Block ads using known ad lists.
- `--waitUntil [event]` : Page load event(s) to wait for.
- `--config [file|stdin]` : Use YAML config file or stdin.

For a full list, run:

```sh
docker run webrecorder/crawlertrix crawl --help
```

Or see [All CLI Options](docs/docs/user-guide/cli-options.md).

---

## YAML Configuration

You can use a YAML file to specify crawl parameters:

```yaml
seeds:
  - https://example.com/
  - https://www.iana.org/
combineWARC: true
```

Run with:

```sh
docker run -v $PWD/crawl-config.yml:/app/crawl-config.yml -v $PWD/crawls:/crawls/ webrecorder/crawlertrix crawl --config /app/crawl-config.yml
```

Or via stdin:

```sh
cat ./crawl-config.yml | docker run -i -v $PWD/crawls:/crawls/ webrecorder/crawlertrix crawl --config stdin
```

See [YAML Config Guide](docs/docs/user-guide/yaml-config.md) for details.

---

## Advanced Options

- **Sitemap parsing**: `--sitemap` to auto-discover URLs.
- **Ad blocking**: `--blockAds` and custom block rules.
- **Custom Puppeteer driver**: Use `--driver` to specify a JS file for custom crawl logic.
- **Screenshots**: `--screenshot view,fullPage,thumbnail`
- **Screencasting**: `--screencastPort 9037` to watch crawl in real-time.
- **State saving/resume**: `--saveState always` and `--saveStateInterval N`
- **S3 upload & webhook**: Set environment variables for S3 and webhook integration.

See [Common Options](docs/docs/user-guide/common-options.md) for more.

---

## Development

### Requirements

- Node.js (see `package.json` for version)
- Yarn or npm
- Docker (for full environment)

### Install

```sh
yarn install
# or
npm install
```

### Run Locally

```sh
yarn start -- [options]
# or
npm run start -- [options]
```

### Test

```sh
yarn test
# or
npm test
```

### Code Structure

- `src/` — Main TypeScript source code
- `tests/` — Automated tests
- `config/` — Example YAML configs and browser policies
- `html/` — UI and replay HTML files
- `docs/` — Documentation (MkDocs)

---

## Support

- Initial support by [Kiwix](https://kiwix.org/) for the [zimit](https://github.com/openzim/zimit) project.
- Additional support by [Portico](https://www.portico.org/).
- For questions, open an [issue](https://github.com/webrecorder/crawlertrix/issues).

---

## License

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later. See [LICENSE](LICENSE) for details.

---

**For more information, see the [official documentation](https://crawler.docs.browsertrix.com).**
