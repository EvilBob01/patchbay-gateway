# Help improve Patchbay

You do not need to write code to contribute. Try connecting a client, tell us where
setup was confusing, or explain a workflow you wish Patchbay supported.

[Discussions](https://github.com/EvilBob01/patchbay-gateway/discussions) has **Help**
for questions, **Ideas** for exploring a use case, and **Show your setup** for
working clients and backend combinations. Use issues for concrete bugs and feature
requests you want tracked.

- [Report a problem](https://github.com/EvilBob01/patchbay-gateway/issues/new?template=bug_report.yml).
  What you tried and what happened are enough to start. Include the release version,
  OS, Node version and client if you know them. Incomplete reports are welcome.
- [Suggest a feature](https://github.com/EvilBob01/patchbay-gateway/issues/new?template=feature_request.yml).
  Describe the task and your current workaround. You do not need a design proposal.
- For a code change, start with a small issue describing the problem so we can
  agree on the scope. Base public pull requests on public `main`.

Issues and screenshots are public. Remove tokens, passwords, private hostnames,
addresses and personal data. Avoid pasting whole environment files or config dumps.
The admin feedback links prefill only the release version; you review the draft
on GitHub before submitting it. Patchbay does not upload diagnostics through them.

## Developing

Use Node.js 20+ and the checked-in lockfile:

```sh
npm ci --ignore-scripts
npm run build
node scripts/demo.mjs --check
npm test
```

`npm test` includes the offline tests and the leak guard. Install
[gitleaks](https://github.com/gitleaks/gitleaks) for the guard; see
[docs/guard.md](docs/guard.md). Use fictional names and RFC 5737 addresses in
examples. Keep fixes focused and explain how you checked the resulting behavior.
