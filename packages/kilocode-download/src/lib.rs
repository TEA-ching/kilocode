/*
 * MIT License
 *
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

pub mod github;

use log::info;
use octocrab::Octocrab;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::github::find_latest_release;

/// Supported platforms for keypool-live kilocode release assets.
///
/// Mirrors packages/kilo-vscode/script/build.ts's VSIX target list exactly (8 targets,
/// unlike cline's clinepool-download which also has a linux-armhf target kilocode doesn't
/// build). The CI workflow (.github/workflows/keypool-live-preview.yml) translates
/// opencode's own build vocabulary ("windows-*", "*-musl") into this same set for the CLI
/// archives, so both --cli and --vsix share one enum instead of two naming schemes for the
/// same physical platforms.
#[derive(Debug, Clone, clap::ValueEnum, PartialEq, Eq)]
pub enum Platform {
    DarwinX64,
    DarwinArm64,
    LinuxX64,
    LinuxArm64,
    AlpineX64,
    AlpineArm64,
    Win32X64,
    Win32Arm64,
}

impl Platform {
    /// Returns the identifier string used in release asset names.
    ///
    /// ```
    /// use kilocode_download::Platform;
    /// assert_eq!(Platform::DarwinX64.as_str(), "darwin-x64");
    /// assert_eq!(Platform::Win32X64.as_str(), "win32-x64");
    /// ```
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::DarwinX64 => "darwin-x64",
            Platform::DarwinArm64 => "darwin-arm64",
            Platform::LinuxX64 => "linux-x64",
            Platform::LinuxArm64 => "linux-arm64",
            Platform::AlpineX64 => "alpine-x64",
            Platform::AlpineArm64 => "alpine-arm64",
            Platform::Win32X64 => "win32-x64",
            Platform::Win32Arm64 => "win32-arm64",
        }
    }

    /// Parses a platform identifier string.
    ///
    /// ```
    /// use kilocode_download::Platform;
    /// assert_eq!(Platform::from_str("darwin-x64"), Some(Platform::DarwinX64));
    /// assert_eq!(Platform::from_str("invalid"), None);
    /// ```
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "darwin-x64" => Some(Platform::DarwinX64),
            "darwin-arm64" => Some(Platform::DarwinArm64),
            "linux-x64" => Some(Platform::LinuxX64),
            "linux-arm64" => Some(Platform::LinuxArm64),
            "alpine-x64" => Some(Platform::AlpineX64),
            "alpine-arm64" => Some(Platform::AlpineArm64),
            "win32-x64" => Some(Platform::Win32X64),
            "win32-arm64" => Some(Platform::Win32Arm64),
            _ => None,
        }
    }

    fn is_windows(&self) -> bool {
        matches!(self, Platform::Win32X64 | Platform::Win32Arm64)
    }
}

/// Custom error type for kilocode-download
#[derive(thiserror::Error, Debug)]
pub enum KilocodeDownloadError {
    #[error("GitHub API error: {0}")]
    GitHubError(#[from] octocrab::Error),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Download error: {0}")]
    DownloadError(#[from] reqwest::Error),
    #[error("Invalid platform: {0}")]
    InvalidPlatform(String),
    #[error("No matching release found")]
    NoReleaseFound,
    #[error("Missing required argument: {0}")]
    MissingArgument(String),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Failed to resolve file path: {0}")]
    PathResolutionError(String),
    #[error("Archive extraction error: {0}")]
    ArchiveError(String),
}

// disable_version_flag prevents clap from auto-generating --version, which
// would conflict with the --version flag for specifying a release version.
#[derive(clap::Parser, Debug)]
#[command(author, about, long_about = None, disable_version_flag = true)]
pub struct Args {
    /// GitHub repository in format owner/repo
    #[arg(long, default_value = "TEA-ching/kilocode")]
    pub repo: String,
    /// keypool-live release version to download (e.g., 0.1.0)
    #[arg(long)]
    pub version: Option<String>,
    /// Target platform (e.g., win32-x64, darwin-arm64)
    #[arg(long)]
    pub arch: Option<String>,
    /// Download the CLI binary and extract it as keypool-code/keypool-code.exe
    #[arg(long, conflicts_with = "vsix")]
    pub cli: bool,
    /// Download the VSIX extension
    #[arg(long, conflicts_with = "cli")]
    pub vsix: bool,
    /// Output file path (--vsix: VSIX; --cli: extracted binary path; use '-' to dump raw archive to stdout for --cli)
    #[arg(long, default_value = "")]
    pub out_file: String,
    /// CLI extraction directory (--cli only); binary is written as keypool-code inside it (used when --out-file is not specified)
    #[arg(long, default_value = "")]
    pub out_dir: String,
    /// Update an existing installation (VSIX: replace the file found on disk/PATH; CLI:
    /// extract the binary into the directory containing the existing `keypool-code` binary)
    #[arg(long)]
    pub update: bool,
    /// Enable verbose logging
    #[arg(short, long, action = clap::ArgAction::Count)]
    pub verbose: u8,
    /// Enable debug logging
    #[arg(long)]
    pub debug: bool,
}

/// Detects the current platform from OS and architecture constants.
///
/// ```
/// use kilocode_download::detect_platform;
/// let platform = detect_platform().unwrap();
/// println!("{}", platform.as_str());
/// ```
pub fn detect_platform() -> Result<Platform, KilocodeDownloadError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "x86_64") => Ok(Platform::DarwinX64),
        ("macos", "aarch64") => Ok(Platform::DarwinArm64),
        ("linux", "x86_64") => Ok(Platform::LinuxX64),
        ("linux", "aarch64") => Ok(Platform::LinuxArm64),
        ("windows", "x86_64") => Ok(Platform::Win32X64),
        ("windows", "aarch64") => Ok(Platform::Win32Arm64),
        (os, arch) => Err(KilocodeDownloadError::InvalidPlatform(format!("{}-{}", os, arch))),
    }
}

/// Writes the downloaded VSIX content to the specified output file or stdout.
pub fn write_output(args: &Args, content: &[u8]) -> Result<(), KilocodeDownloadError> {
    if args.out_file == "-" {
        io::stdout().write_all(content)?;
        return Ok(());
    }

    let output_path = if args.out_file.is_empty() {
        Path::new("keypool-code.vsix").to_path_buf()
    } else {
        Path::new(&args.out_file).to_path_buf()
    };

    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    fs::write(&output_path, content)?;
    info!("Saved to: {}", output_path.display());
    Ok(())
}

/// Extracts the CLI binary from a downloaded archive (.tar.gz on Linux/macOS,
/// .zip on Windows — see .github/workflows/keypool-live-preview.yml's release job)
/// to `dest_file`.
///
/// Only the `kilo`/`kilo.exe` binary entry is extracted and written to
/// `dest_file` (renamed from `kilo`/`kilo.exe`); all other files in the archive
/// (bwrap, tree-sitter WASM resources, etc.) are skipped.
///
/// Dispatches on the `.zip` vs `.tar.gz` suffix of `asset_name` — the archive
/// format is an artifact of the OS packaging it (zip on Windows, tar.gz elsewhere),
/// not of the target platform.
pub fn extract_archive(
    asset_name: &str,
    content: &[u8],
    dest_file: &Path,
    platform: &Platform,
) -> Result<(), KilocodeDownloadError> {
    let source = cli_binary_name(platform);

    if let Some(parent) = dest_file.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    if asset_name.ends_with(".zip") {
        let reader = io::Cursor::new(content);
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|e| KilocodeDownloadError::ArchiveError(e.to_string()))?;
        let mut found = false;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| KilocodeDownloadError::ArchiveError(e.to_string()))?;
            let is_match = Path::new(entry.name())
                .file_name()
                .and_then(|n| n.to_str())
                == Some(source);
            if is_match {
                let mut outfile = fs::File::create(dest_file)?;
                io::copy(&mut entry, &mut outfile)?;
                found = true;
                break;
            }
        }
        if !found {
            return Err(KilocodeDownloadError::FileNotFound(format!(
                "Binary '{}' not found in archive",
                source
            )));
        }
    } else {
        // .tar.gz — tar stores Unix permission bits in the header, so we copy
        // them onto the extracted binary to keep the executable bit on `kilo`.
        let decoder = flate2::read::GzDecoder::new(content);
        let mut archive = tar::Archive::new(decoder);
        let mut found = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            let entry_path = entry.path()?.to_path_buf();
            if entry_path.file_name().and_then(|n| n.to_str()) == Some(source) {
                let mut outfile = fs::File::create(dest_file)?;
                io::copy(&mut entry, &mut outfile)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = entry.header().mode().unwrap_or(0o755);
                    let mut perms = fs::metadata(dest_file)?.permissions();
                    perms.set_mode(mode);
                    fs::set_permissions(dest_file, perms)?;
                }
                found = true;
                break;
            }
        }
        if !found {
            return Err(KilocodeDownloadError::FileNotFound(format!(
                "Binary '{}' not found in archive",
                source
            )));
        }
    }

    info!("Extracted {} to: {}", source, dest_file.display());
    Ok(())
}

/// Finds the path to an existing file in the current directory or PATH.
/// Returns the resolved path if found, or an error if not found.
pub fn find_existing_file(target_name: &str) -> Result<PathBuf, KilocodeDownloadError> {
    // First, check current directory
    let current_dir_path = Path::new(".").join(target_name);
    if current_dir_path.exists() {
        let resolved_path = fs::canonicalize(&current_dir_path)
            .map_err(|e| KilocodeDownloadError::PathResolutionError(e.to_string()))?;
        info!("Found file in current directory: {}", resolved_path.display());
        return Ok(resolved_path);
    }

    // Then, check PATH environment variable
    if let Some(path_env) = env::var_os("PATH") {
        for path in env::split_paths(&path_env) {
            let candidate_path = path.join(target_name);
            if candidate_path.exists() {
                let resolved_path = fs::canonicalize(&candidate_path)
                    .map_err(|e| KilocodeDownloadError::PathResolutionError(e.to_string()))?;
                info!("Found file in PATH: {}", resolved_path.display());
                return Ok(resolved_path);
            }
        }
    }

    Err(KilocodeDownloadError::FileNotFound(format!(
        "Could not find '{}' in current directory or PATH",
        target_name
    )))
}

/// Replaces an existing file with new content, preserving executable permissions on Unix.
pub fn replace_existing_file(existing_path: &Path, new_content: &[u8]) -> Result<(), KilocodeDownloadError> {
    #[cfg(unix)]
    let was_executable = {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(existing_path)?;
        metadata.permissions().mode() & 0o111 != 0
    };

    fs::write(existing_path, new_content)?;

    #[cfg(unix)]
    if was_executable {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(existing_path)?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(existing_path, permissions)?;
        info!("Restored executable permissions on: {}", existing_path.display());
    }

    info!("Replaced file: {}", existing_path.display());
    Ok(())
}

fn cli_binary_name(platform: &Platform) -> &'static str {
    if platform.is_windows() { "kilo.exe" } else { "kilo" }
}

fn keypool_binary_name(platform: &Platform) -> &'static str {
    if platform.is_windows() { "keypool-code.exe" } else { "keypool-code" }
}

/// Executes the main logic of the application.
pub async fn main_logic(args: &Args, octocrab: Octocrab) -> Result<(), KilocodeDownloadError> {
    if !args.cli && !args.vsix {
        return Err(KilocodeDownloadError::MissingArgument(
            "Either --cli or --vsix must be specified".to_string(),
        ));
    }

    let platform = match args.arch.as_ref() {
        Some(arch) => Platform::from_str(arch).ok_or_else(|| KilocodeDownloadError::InvalidPlatform(arch.clone()))?,
        None => detect_platform()?,
    };

    info!("Platform: {}", platform.as_str());

    let release = find_latest_release(&octocrab, &args.repo, args.version.as_deref()).await?;

    let platform_str = platform.as_str();
    let asset = if args.cli {
        let tar_name = format!("keypool-code-cli-{}.tar.gz", platform_str);
        let zip_name = format!("keypool-code-cli-{}.zip", platform_str);
        release.assets.iter().find(|a| a.name == tar_name || a.name == zip_name)
    } else {
        release
            .assets
            .iter()
            .find(|a| a.name.starts_with("kilo-vscode-") && a.name.ends_with(&format!("-{}.vsix", platform_str)))
    }
    .ok_or(KilocodeDownloadError::NoReleaseFound)?;

    info!("Found asset: {}", asset.name);
    info!("Downloading: {} ({} bytes)", asset.name, asset.size);

    let content = reqwest::get(asset.browser_download_url.as_str())
        .await?
        .bytes()
        .await?
        .to_vec();

    if args.cli {
        // Raw-archive mode: '--out-file -' dumps the downloaded archive as-is to
        // stdout, for scripting/manual use.
        if args.out_file == "-" {
            io::stdout().write_all(&content)?;
            return Ok(());
        }

        // Determine the output file path for the extracted binary.
        // Priority: --out-file > --update (find existing) > --out-dir > default (current dir).
        let dest_file = if !args.out_file.is_empty() {
            PathBuf::from(&args.out_file)
        } else if args.update {
            let binary_name = keypool_binary_name(&platform);
            find_existing_file(binary_name)?
        } else if args.out_dir.is_empty() {
            PathBuf::from(keypool_binary_name(&platform))
        } else {
            PathBuf::from(&args.out_dir).join(keypool_binary_name(&platform))
        };

        extract_archive(&asset.name, &content, &dest_file, &platform)?;
    } else if args.update {
        let target_name = "keypool-code.vsix";
        let existing_path = find_existing_file(target_name)?;

        if args.out_file == "-" {
            return Err(KilocodeDownloadError::MissingArgument(
                "Cannot use --update with stdout output (--out-file -)".to_string(),
            ));
        }

        let target_path = if args.out_file.is_empty() {
            existing_path
        } else {
            PathBuf::from(&args.out_file)
        };

        replace_existing_file(&target_path, &content)?;
    } else {
        write_output(args, &content)?;
    }

    Ok(())
}

#[cfg(test)]
mod github_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;
