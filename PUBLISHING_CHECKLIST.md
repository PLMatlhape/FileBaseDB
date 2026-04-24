# FileBaseDB Publishing Checklist

Use this checklist before publishing a release of FileBaseDB.

## API and compatibility

- [ ] Bump the version in `package.json` according to semver.
- [ ] Confirm the public API in `src/index.ts` is stable and intentional.
- [ ] Avoid breaking changes unless the major version is increased.
- [ ] Verify the package entry points (`main`, `types`, `exports`) are correct.

## Build and validation

- [ ] Run `npm test` and confirm it passes.
- [ ] Run a clean build from scratch.
- [ ] Verify declaration files are generated correctly in `dist/`.
- [ ] Check that `npm pack` contains only intended files.

## Security and privacy

- [ ] Ensure no secrets, tokens, or sample credentials are committed.
- [ ] Confirm logs do not print access tokens, refresh tokens, or raw API responses.
- [ ] Review OAuth scopes and keep them minimal.
- [ ] Confirm cache and metadata are only stored locally or in the user's chosen cloud folder.
- [ ] Review dependency updates for known security issues.

## Documentation

- [ ] Update `README.md` for any behavior changes.
- [ ] Update examples if the API changed.
- [ ] Keep installation and usage instructions accurate.
- [ ] Mention supported Node.js versions clearly.

## Release process

- [ ] Tag the release in git.
- [ ] Create GitHub release notes.
- [ ] Publish to npm only after validation passes.
- [ ] Smoke-test the installed package after publishing.

## Optional hardening

- [ ] Add integration tests for Google Drive and OneDrive adapters.
- [ ] Add dependency and secret scanning in CI.
- [ ] Review rate-limit and retry behavior for provider API calls.
- [ ] Consider adding a `SECURITY.md` file for vulnerability reporting.
