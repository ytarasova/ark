fn main() {
    // Expose the Rust target triple so sidecar.rs can locate the
    // platform-specific externalBin binary at runtime.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_else(|_| String::from("unknown"))
    );
    tauri_build::build()
}
