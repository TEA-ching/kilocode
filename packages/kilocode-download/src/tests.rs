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

use super::*;
use clap::Parser;

#[test]
fn test_platform_conversions() {
    let pairs = [
        (Platform::DarwinX64, "darwin-x64"),
        (Platform::DarwinArm64, "darwin-arm64"),
        (Platform::LinuxX64, "linux-x64"),
        (Platform::LinuxArm64, "linux-arm64"),
        (Platform::AlpineX64, "alpine-x64"),
        (Platform::AlpineArm64, "alpine-arm64"),
        (Platform::Win32X64, "win32-x64"),
        (Platform::Win32Arm64, "win32-arm64"),
    ];
    for (variant, s) in pairs {
        assert_eq!(variant.as_str(), s);
        assert_eq!(Platform::from_str(s).unwrap().as_str(), s);
    }
    assert_eq!(Platform::from_str("invalid"), None);
    assert_eq!(Platform::from_str(""), None);
    // kilocode doesn't build a linux-armhf target (unlike cline's clinepool-download) —
    // guard against silently re-adding it without also wiring up a CI build for it.
    assert_eq!(Platform::from_str("linux-armhf"), None);
}

#[test]
fn test_detect_platform_succeeds() {
    assert!(detect_platform().is_ok());
}

#[test]
fn test_args_defaults() {
    let args = Args::parse_from(["test"]);
    assert_eq!(args.repo, "TEA-ching/kilocode");
    assert!(args.version.is_none() && args.arch.is_none());
    assert!(!args.cli && !args.vsix);
    assert_eq!(args.out_file, "");
    assert_eq!(args.out_dir, "");
    assert_eq!(args.verbose, 0);
}

#[test]
fn test_args_all_flags() {
    let args = Args::parse_from([
        "test", "--repo", "org/repo", "--version", "0.1.0",
        "--arch", "win32-x64", "--cli", "--out-dir", "./out", "-v",
    ]);
    assert_eq!(args.repo, "org/repo");
    assert_eq!(args.version, Some("0.1.0".to_string()));
    assert_eq!(args.arch, Some("win32-x64".to_string()));
    assert!(args.cli && !args.vsix);
    assert_eq!(args.out_dir, "./out");
    assert_eq!(args.verbose, 1);
    assert!(!args.debug);
}

#[test]
fn test_args_debug_flag() {
    let args = Args::parse_from(["test", "--debug"]);
    assert!(args.debug);
}

#[test]
fn test_args_vsix_and_mutual_exclusion() {
    assert!(Args::parse_from(["test", "--vsix"]).vsix);
    assert!(Args::try_parse_from(["test", "--cli", "--vsix"]).is_err());
}

#[test]
fn test_error_display_messages() {
    assert_eq!(KilocodeDownloadError::InvalidPlatform("bad".to_string()).to_string(), "Invalid platform: bad");
    assert_eq!(KilocodeDownloadError::NoReleaseFound.to_string(), "No matching release found");
    assert_eq!(KilocodeDownloadError::MissingArgument("x".to_string()).to_string(), "Missing required argument: x");
}
