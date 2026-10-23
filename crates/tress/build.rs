use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=TRESS_EMBED_RUNTIME");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("runtime_assets.rs");
    let mut source = String::from("const RUNTIME_ASSETS: &[(&str, &[u8])] = &[\n");
    if env::var("TRESS_EMBED_RUNTIME").as_deref() == Ok("1")
        && env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32")
    {
        let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("../../packages/harness-host/dist");
        for name in [
            "host.mjs",
            "browser.js",
            "browser.css",
            "wasm/package.json",
            "wasm/tress_wasm.js",
            "wasm/tress_wasm_bg.wasm",
        ] {
            let path = root.join(name).canonicalize().unwrap_or_else(|_| {
                panic!("Build packages/harness-host before setting TRESS_EMBED_RUNTIME=1: {name}")
            });
            println!("cargo:rerun-if-changed={}", path.display());
            source.push_str(&format!("({name:?}, include_bytes!({path:?})),\n"));
        }
    }
    source.push_str("];");
    fs::write(out, source).unwrap();
}
