# Detect the Project's Tech

Used by `init-tech-declaration` to generate `.opencode/harness/rules/tech.md`. Do NOT run this
at session start — read `.opencode/harness/rules/tech.md` instead.

---

## Step 1 — Detect candidate manifests

Find every manifest in the repo (root + subdirectories): `package.json`,
`go.mod`, `Cargo.toml`, `pyproject.toml` / `requirements.txt` / `setup.py`,
`Gemfile`, `composer.json`, `pubspec.yaml`, `Package.swift`, `pom.xml`,
`build.gradle` / `build.gradle.kts`, `*.csproj` / `*.fsproj`, `CMakeLists.txt`,
`build.zig`, `mix.exs`, etc.

If more than one manifest exists → this is a **polyglot repo**. Resolve with
Step 3, not by guessing.

---

## Step 2 — Map the manifest to a `.opencode/harness/tech/<dir>/`

Use the file the skill is acting on to pick the row. "Deps" = a key in
`package.json` `dependencies` / `devDependencies`.

### Non-JS/TS (1:1 with language)

Mapping is 1:1 with the language, then refined by framework detection below.

| Manifest / signal            | Tech dir     |
| :--------------------------- | :----------- |
| `go.mod`                     | `golang`     |
| `Cargo.toml`                 | `rust`       |
| `pyproject.toml` / `requirements.txt` / `setup.py` | `python` |
| `Gemfile`                    | `ruby`       |
| `composer.json`              | `php`        |
| `pubspec.yaml` (Flutter/Dart) | `dart`       |
| `Package.swift`              | `swift`      |
| `*.csproj` (C#)              | `csharp`     |
| `*.fsproj` or `.fs` files (F#) | `fsharp`   |
| `CMakeLists.txt` / `.c` / `.cpp` / `.h` | `cpp` |
| `build.gradle` + `.java`     | `java`       |
| `build.gradle.kts` + `.kt`   | `kotlin`     |
| HarmonyOS project (`oh-package.json5`, `.ets` files) | `arkts` |
| `Makefile.PL` / `cpanfile` / `.pl` | `perl` |

If a manifest signals a tech dir that does not exist, fall back to `common/`
only and write in the target language's idioms.

#### Framework hints (non-JS)

After resolving the language dir, check deps for known frameworks. If matched,
append the framework as a hint in parentheses (e.g. `python (fastapi)`). The
router then points at both the language dir and any framework-specific file
inside it (e.g. `tech/python/fastapi.md`).

| Language | Dep / signal in manifest           | Framework hint |
| :------- | :--------------------------------- | :------------- |
| python   | `fastapi` in requirements/pyproject | `python (fastapi)` |
| python   | `django` in requirements/pyproject  | `python (django)`  |
| python   | `flask` in requirements/pyproject   | `python (flask)`   |
| ruby     | `rails` in Gemfile                  | `ruby (rails)`     |
| php      | `laravel/framework` in composer     | `php (laravel)`    |

Only record a hint when a corresponding `tech/<lang>/<framework>.md` file
exists; otherwise the hint adds noise without a file to point at.

### JS/TS (framework-aware — check `deps` in priority order)

| Dep key (first match wins)       | Tech dir                     | Notes                                  |
| :-------------------------------- | :--------------------------- | :------------------------------------- |
| `expo`, `react-native`           | `react-native`               | Also load `react/` for the web layer.  |
| `nuxt`                           | `nuxt`                       |                                        |
| `@angular/core`                  | `angular`                    |                                        |
| `vue`                            | `vue`                        |                                        |
| `next`, `remix`, `@remix-run`    | `react` + `web`              | Next/Remix are React-meta; no own dir. |
| `react`, `react-dom`             | `react`                      |                                        |
| `svelte`, `@sveltejs/kit`, `astro` | `web` (+ `typescript`)     | No dedicated dir; `web` is closest.    |
| none of the above, TS present    | `typescript`                 |                                        |
| none of the above, JS only       | `typescript`                 | Same file set as TS.                    |

**Always also load `common/`** — it holds the universal baselines every tech
dir extends.

---

## Step 3 — Polyglot resolution (proximity, not "pick one")

When multiple manifests exist, **do not pick a single global tech set.**
Resolve per file:

1. From the target file's directory, walk **up** until you find the nearest
   manifest. That manifest's tech (Step 2) wins for that file.
2. If editing root-level config / cross-cutting code with no nearer manifest,
   use the **primary language** = the language with the most source files in
   the repo (or the root manifest).
3. If a single task touches two tech sets (e.g. a Rust backend + React
   frontend endpoint), load **both** tech dirs and apply each to its own code.
   Do not mix conventions across the boundary.
