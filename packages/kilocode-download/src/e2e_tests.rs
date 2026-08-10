use super::Args;
use clap::Parser;
use octocrab::Octocrab;
use std::fs;
use tempfile;

/// Test end-to-end pour télécharger la CLI pour Darwin x64
#[tokio::test]
#[ignore = "Test réel, nécessite une connexion Internet"]
async fn test_download_cli_for_darwin_x64_e2e() {
    let octocrab = Octocrab::builder().build().unwrap();

    let temp_dir = tempfile::tempdir().unwrap();
    let out_dir = temp_dir.path().join("kilocode-cli");

    let args = Args::parse_from([
        "test",
        "--repo", "TEA-ching/kilocode",
        "--cli",
        "--arch", "darwin-x64",
        "--out-dir", out_dir.to_str().unwrap(),
    ]);

    let result = super::main_logic(&args, octocrab).await;

    assert!(result.is_ok());
    assert!(out_dir.join("keypool-code").exists());

    let metadata = fs::metadata(out_dir.join("keypool-code")).unwrap();
    assert!(metadata.len() > 0);
}

/// Test end-to-end pour télécharger le VSIX pour Win32 x64
#[tokio::test]
#[ignore = "Test réel, nécessite une connexion Internet"]
async fn test_download_vsix_for_win32_x64_e2e() {
    let octocrab = Octocrab::builder().build().unwrap();

    let temp_dir = tempfile::tempdir().unwrap();
    let output_path = temp_dir.path().join("keypool-code.vsix");

    let args = Args::parse_from([
        "test",
        "--repo", "TEA-ching/kilocode",
        "--vsix",
        "--arch", "win32-x64",
        "--out-file", output_path.to_str().unwrap(),
    ]);

    let result = super::main_logic(&args, octocrab).await;

    assert!(result.is_ok());
    assert!(output_path.exists());

    let metadata = fs::metadata(&output_path).unwrap();
    assert!(metadata.len() > 0);
}

/// Test end-to-end pour télécharger la CLI pour Linux ARM64
#[tokio::test]
#[ignore = "Test réel, nécessite une connexion Internet"]
async fn test_download_cli_for_linux_arm64_e2e() {
    let octocrab = Octocrab::builder().build().unwrap();

    let temp_dir = tempfile::tempdir().unwrap();
    let out_dir = temp_dir.path().join("kilocode-cli");

    let args = Args::parse_from([
        "test",
        "--repo", "TEA-ching/kilocode",
        "--cli",
        "--arch", "linux-arm64",
        "--out-dir", out_dir.to_str().unwrap(),
    ]);

    let result = super::main_logic(&args, octocrab).await;

    assert!(result.is_ok());
    assert!(out_dir.join("keypool-code").exists());

    let metadata = fs::metadata(out_dir.join("keypool-code")).unwrap();
    assert!(metadata.len() > 0);
}

/// Test end-to-end pour télécharger le VSIX pour Linux x64
#[tokio::test]
#[ignore = "Test réel, nécessite une connexion Internet"]
async fn test_download_vsix_for_linux_x64_e2e() {
    let octocrab = Octocrab::builder().build().unwrap();

    let temp_dir = tempfile::tempdir().unwrap();
    let output_path = temp_dir.path().join("keypool-code.vsix");

    let args = Args::parse_from([
        "test",
        "--repo", "TEA-ching/kilocode",
        "--vsix",
        "--arch", "linux-x64",
        "--out-file", output_path.to_str().unwrap(),
    ]);

    let result = super::main_logic(&args, octocrab).await;

    assert!(result.is_ok());
    assert!(output_path.exists());

    let metadata = fs::metadata(&output_path).unwrap();
    assert!(metadata.len() > 0);
}
