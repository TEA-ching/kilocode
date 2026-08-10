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

use clap::Parser;
use kilocode_download::{Args, KilocodeDownloadError, main_logic};
use octocrab::Octocrab;
use log::debug;

#[tokio::main]
async fn main() -> Result<(), KilocodeDownloadError> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    let args = Args::parse();

    let log_level = if args.debug {
        log::LevelFilter::Debug
    } else if args.verbose > 0 {
        log::LevelFilter::Info
    } else {
        log::LevelFilter::Off
    };

    env_logger::Builder::new()
        .filter_level(log_level)
        .parse_env("RUST_LOG")
        .init();

    debug!("Parsed arguments: {:?}", args);

    let octocrab = Octocrab::builder().build()?;
    main_logic(&args, octocrab).await
}

#[cfg(test)]
mod tests {
    use kilocode_download::Args;
    use clap::Parser;

    #[test]
    fn test_write_output_stdout() {
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok();
        let args = Args::parse_from(["test", "--vsix", "--out-file", "-"]);
        assert!(kilocode_download::write_output(&args, b"").is_ok());
    }

    #[test]
    fn test_write_output_creates_parent_dirs() {
        let dir = std::env::temp_dir().join("kilocode_download_test_output");
        let path = dir.join("nested").join("test.vsix");
        let args = Args::parse_from([
            "test", "--vsix", "--out-file",
            path.to_str().unwrap(),
        ]);
        assert!(kilocode_download::write_output(&args, b"test").is_ok());
        assert!(path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_write_output_default_vsix_name() {
        let args = Args::parse_from(["test", "--vsix"]);
        assert!(kilocode_download::write_output(&args, b"").is_ok());
        std::fs::remove_file("keypool-code.vsix").ok();
    }

    #[test]
    fn test_extract_archive_tar_gz() {
        let dir = std::env::temp_dir().join("kilocode_download_test_extract_targz");
        std::fs::remove_dir_all(&dir).ok();

        // Build a minimal .tar.gz containing a single "kilo" file in memory.
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "kilo", &b"hello"[..]).unwrap();
            builder.finish().unwrap();
        }
        let mut gz_bytes = Vec::new();
        {
            use flate2::write::GzEncoder;
            use std::io::Write;
            let mut encoder = GzEncoder::new(&mut gz_bytes, flate2::Compression::default());
            encoder.write_all(&tar_bytes).unwrap();
            encoder.finish().unwrap();
        }

        let dest_file = dir.join("keypool-code");
        let result = kilocode_download::extract_archive("keypool-code-cli-linux-x64.tar.gz", &gz_bytes, &dest_file, &kilocode_download::Platform::LinuxX64);
        assert!(result.is_ok());
        assert!(dest_file.exists());
        assert_eq!(std::fs::read(&dest_file).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_extract_archive_zip() {
        use std::io::{Cursor, Write};
        use zip::write::{FileOptions, ZipWriter};

        let dir = std::env::temp_dir().join("kilocode_download_test_extract_zip");
        std::fs::remove_dir_all(&dir).ok();

        // Build a minimal .zip containing a single "kilo.exe" file in memory.
        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut zip_bytes));
            writer.start_file("kilo.exe", FileOptions::<()>::default()).unwrap();
            writer.write_all(b"hello").unwrap();
            writer.finish().unwrap();
        }

        let dest_file = dir.join("keypool-code.exe");
        let result = kilocode_download::extract_archive(
            "keypool-code-cli-win32-x64.zip",
            &zip_bytes,
            &dest_file,
            &kilocode_download::Platform::Win32X64,
        );
        assert!(result.is_ok());
        assert!(dest_file.exists());
        assert_eq!(std::fs::read(&dest_file).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_find_existing_file_not_found() {
        let result = kilocode_download::find_existing_file("nonexistent-file");
        assert!(matches!(result, Err(kilocode_download::KilocodeDownloadError::FileNotFound(_))));
    }

    #[test]
    fn test_find_existing_file_in_current_dir() {
        let test_file = "test-kilo-executable";
        std::fs::write(test_file, "test content").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(test_file).unwrap();
            let mut permissions = metadata.permissions();
            permissions.set_mode(permissions.mode() | 0o111);
            std::fs::set_permissions(test_file, permissions).unwrap();
        }

        let result = kilocode_download::find_existing_file(test_file);
        assert!(result.is_ok());
        let found_path = result.unwrap();
        assert!(found_path.ends_with(test_file));

        std::fs::remove_file(test_file).ok();
    }

    #[test]
    fn test_replace_existing_file_preserves_permissions() {
        let test_file = "test-replace-file";
        let original_content = b"original content";
        std::fs::write(test_file, original_content).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(test_file).unwrap();
            let mut permissions = metadata.permissions();
            permissions.set_mode(permissions.mode() | 0o111);
            std::fs::set_permissions(test_file, permissions).unwrap();
        }

        #[cfg(unix)]
        let was_executable = {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(test_file).unwrap();
            metadata.permissions().mode() & 0o111 != 0
        };

        let new_content = b"new content";
        let result = kilocode_download::replace_existing_file(std::path::Path::new(test_file), new_content);
        assert!(result.is_ok());

        let replaced_content = std::fs::read(test_file).unwrap();
        assert_eq!(replaced_content, new_content);

        #[cfg(unix)]
        if was_executable {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(test_file).unwrap();
            assert_ne!(metadata.permissions().mode() & 0o111, 0, "Executable permissions should be preserved");
        }

        std::fs::remove_file(test_file).ok();
    }

    #[test]
    fn test_update_flag_parsing() {
        let args = Args::parse_from(["test", "--cli", "--update"]);
        assert!(args.update);
        assert!(args.cli);
        assert!(!args.vsix);

        let args = Args::parse_from(["test", "--vsix", "--update"]);
        assert!(args.update);
        assert!(args.vsix);
        assert!(!args.cli);
    }
}
