use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let frontend_dir = manifest_dir.join("../../frontend");
    let dist_index = frontend_dir.join("dist/index.html");

    declare_watch(&frontend_dir);

    if env::var("CASTIFY_SKIP_FRONTEND_BUILD").is_ok() {
        if !dist_index.exists() {
            panic!("CASTIFY_SKIP_FRONTEND_BUILD is set but frontend/dist/index.html is missing; build the frontend first");
        }
        return;
    }

    let npm = env::var("CASTIFY_NPM").unwrap_or_else(|_| "npm".to_string());
    let status = Command::new(&npm)
        .arg("run")
        .arg("build")
        .current_dir(&frontend_dir)
        .status()
        .unwrap_or_else(|e| panic!("failed to invoke `{npm} run build`: {e}"));
    if !status.success() {
        panic!("frontend build failed (`{npm} run build`)");
    }
}

fn declare_watch(frontend_dir: &Path) {
    let watch_paths = [
        "package.json",
        "package-lock.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "eslint.config.js",
        "tailwind.config.js",
        "postcss.config.js",
        "src",
        // Legacy TV player assets (public/tv/*) ship verbatim through the
        // embed — edits must retrigger the frontend build.
        "public",
        // Tracking the build output too: if dist/index.html is missing (e.g.
        // after `cargo clean` or a fresh clone), cargo will rerun build.rs and
        // regenerate it. Without this, rust-embed's macro fails to compile.
        "dist/index.html",
    ];
    for p in watch_paths {
        let full = frontend_dir.join(p);
        println!("cargo:rerun-if-changed={}", full.display());
    }
}
