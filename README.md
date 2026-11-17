# local-browser

A safe, token-lean local browser for AI agents: a CLI and MCP server that drives the Chrome or Edge already on your machine.

> **Status: early development (pre-v0.1).** Not ready for use yet.

Agents waste tokens on raw HTML, and giving them your everyday browser profile is risky. local-browser runs your installed browser with a separate profile, shows the agent compact page snapshots, logs every action, and stops for a human "yes" before risky steps like submitting a form.

## Requirements
- Node.js 22+
- Google Chrome or Microsoft Edge
- Windows or Linux, tested in CI. macOS should work but isn't tested in CI yet. No GPU needed.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security
See [SECURITY.md](SECURITY.md). Don't open public issues for vulnerabilities.

## License
MIT, see [LICENSE](LICENSE).
