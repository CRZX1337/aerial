## What does this PR change?

<!-- What + why. A reviewer should not have to reverse-engineer your diff. -->

## Scope check

- [ ] Aerial stays a pure player — no hosting/proxying of IPTV content
- [ ] Provider credentials never reach the server, logs, or error messages
- [ ] No silent failures (every `play()`, fetch and recovery path handled)
- [ ] CSP stays strict (no `unsafe-inline` / `unsafe-eval`)

## Testing

- [ ] `npm test` is green
- [ ] Manually verified against the mock provider (`node scripts/mock-xtream.js 8090`)

<!-- Note: new features need tests, bug fixes need a regression test. -->
