# Crawlertrix 1.x

Crawlertrix is a standalone browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Crawlertrix uses [Puppeteer](https://github.com/puppeteer/puppeteer) to control one or more [Brave Browser](https://brave.com/) browser windows in parallel. Data is captured through the [Chrome Devtools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) in the browser.

For information on how to use and develop Crawlertrix, see the hosted [Crawlertrix documentation](https://crawler.docs.browsertrix.com).

For information on how to build the docs locally, see the [docs page](docs/docs/develop/docs.md).


## Support
Initial support for 0.x version of Crawlertrix, was provided by [Kiwix](https://kiwix.org/). The initial functionality for Crawlertrix was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.

Additional support for Crawlertrix, including for the development of the 0.4.x version has been provided by [Portico](https://www.portico.org/).

## License

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see [LICENSE](LICENSE) for more details.
