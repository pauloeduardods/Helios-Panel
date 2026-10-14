# Contributing

## Commit messages

Every commit follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), written in English:

```
<type>(<optional scope>): <short summary in the imperative, lowercase, no period>

<optional body: what changed and why, wrapped at 72 columns>

<optional footers, e.g. BREAKING CHANGE: ... or Refs: #12>
```

Types:

| Type | Use for |
|---|---|
| `feat` | a new user-visible feature |
| `fix` | a bug fix (ships with a regression test) |
| `docs` | documentation only |
| `test` | adding or fixing tests only |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `perf` | performance improvement |
| `build` | build system, packaging, `install.sh` |
| `ci` | GitHub Actions and other CI configuration |
| `chore` | anything else that does not touch shipped behavior |

Scopes name the part of the project: `extension`, `prefs`, `core`, `daemon`, `cli`, `install`, `i18n`, `lighting`.

A breaking change adds `!` after the type/scope (`feat(daemon)!: ...`) and a `BREAKING CHANGE:` footer.

Examples:

```
feat(daemon): expose platform profile over the system bus
fix(extension): stop the readback timer on disable
ci: run npm test and npm run check on every pull request
```

## Pull requests

- `main` is protected: every change goes on its own branch and lands through a pull request, with linear history.
- The pull request title follows the same Conventional Commits format, since it becomes the commit on `main`.
- `npm test` and `npm run check` (and, once the Rust workspace exists, `cargo test` and `cargo clippy -- -D warnings`) must pass.
