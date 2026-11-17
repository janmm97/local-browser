# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project scaffold: MIT licence, docs, issue/PR templates, CI on Linux and Windows.
- Policy file (`allowedDomains`, `blockedDomains`, `confirm`, `maxSnapshotChars`) with strict validation; only `http(s)` and `about:blank` URLs are allowed.
- JSONL action log with password redaction.
