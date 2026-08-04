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

use octocrab::{Octocrab, models::repos::Release};

use crate::KilocodeDownloadError;

/// Finds the latest preview release from the given repository.
///
/// Queries the GitHub API for all releases, filters for those whose tag contains
/// "preview", then returns the most recently published one. When `version` is
/// provided, only releases whose tag starts with that version string are considered,
/// so that among several previews of the same version the newest is returned.
///
/// # Arguments
///
/// * `octocrab` - Authenticated Octocrab client
/// * `repo` - Repository in `"owner/repo"` format
/// * `version` - Optional version prefix (e.g., `"3.88.1"`)
///
/// # Examples
///
/// ```
/// rustls::crypto::ring::default_provider()
///        .install_default()
///        .ok();
/// let rt = tokio::runtime::Runtime::new().unwrap();
/// rt.block_on(async {
///     let client = octocrab::Octocrab::builder().build().unwrap();
///     // In real usage: find_latest_release(&client, "owner/repo", None).await
/// });
/// ```
pub async fn find_latest_release(
    octocrab: &Octocrab,
    repo: &str,
    version: Option<&str>,
) -> Result<Release, KilocodeDownloadError> {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return Err(KilocodeDownloadError::MissingArgument(format!(
            "Invalid repository format: {}",
            repo
        )));
    }

    let releases = octocrab
        .repos(parts[0], parts[1])
        .releases()
        .list()
        .send()
        .await?;

    let previews: Vec<Release> = releases
        .items
        .into_iter()
        .filter(|r| r.tag_name.contains("preview"))
        .collect();

    if previews.is_empty() {
        return Err(KilocodeDownloadError::NoReleaseFound);
    }

    let candidates: Vec<Release> = match version {
        Some(v) => previews.into_iter().filter(|r| r.tag_name.contains(v)).collect(),
        None => previews,
    };

    if candidates.is_empty() {
        return Err(KilocodeDownloadError::NoReleaseFound);
    }

    candidates
        .into_iter()
        .max_by(|a, b| a.published_at.cmp(&b.published_at))
        .ok_or(KilocodeDownloadError::NoReleaseFound)
}
