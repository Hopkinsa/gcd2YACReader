# YAC GCD Scraper

Desktop metadata workspace for a YACReader library and the Grand Comics Database (GCD) SQLite export.

See [README](yacGCDscraper/README.md) for details on what the application does and how to use it.

See [Architecture and operations](yacGCDscraper/docs/architecture-and-operations.md) for the component design, data lifecycle, matching and import rules, backup recovery, configuration, and development workflow.

The app is designed to preserve the original YACReader database. Direct updates require an explicit review and confirmation in the application. Close YACReader before applying updates so the library is not being modified by another process.
