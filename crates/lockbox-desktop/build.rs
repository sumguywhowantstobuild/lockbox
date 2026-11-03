include!("src/commands/list.rs");

fn main() {
    // Each command gets an `allow-<command>` permission, so the page can call only what the capability grants.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
    embed_test_manifest();
}

/// Tauri needs Windows' Common Controls 6, which a program gets from its application manifest. tauri-build embeds
/// that manifest in the app itself but not in test programs, which then fail to start with
/// `STATUS_ENTRYPOINT_NOT_FOUND`. This gives the test programs the same manifest (Tauri's own workaround, from its
/// `crates/tauri/build.rs`).
fn embed_test_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    let manifest = std::path::Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"))
        .join("test-manifest.xml");
    std::fs::write(&manifest, COMMON_CONTROLS_6_MANIFEST).expect("write the test manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}

/// The same text as tauri-build's `src/windows-app-manifest.xml` (2.7.4).
const COMMON_CONTROLS_6_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
