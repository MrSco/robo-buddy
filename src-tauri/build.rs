fn main() {
    // Re-embed frontend assets and their commit stamp after a clean frontend rebuild.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
