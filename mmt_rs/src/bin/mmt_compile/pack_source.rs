use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::{AnalyzedDocument, PackStorageSource, ResolvedResourceKind};
use sha2::{Digest, Sha256};
use url::Url;

const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RESOURCE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub struct LoadedPacks {
    pub registry: PackRegistry,
    sources: HashMap<String, PackSource>,
}

#[derive(Debug)]
struct PackSource {
    local_root: Option<PathBuf>,
    remote_base: Option<Url>,
    manifest_digest: String,
}

#[derive(Debug, Clone)]
struct RequiredObject {
    relative: PathBuf,
    expected_sha256: Option<String>,
}

pub fn load_registry(inputs: &[String], allow_insecure_http: bool) -> Result<LoadedPacks, String> {
    let agent = http_agent();
    let mut manifests = Vec::new();
    let mut sources = HashMap::new();

    for input in inputs {
        let parsed_url = Url::parse(input)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"));
        let (bytes, local_root, source_name) = if let Some(url) = parsed_url {
            validate_remote_url(&url, allow_insecure_http)?;
            (
                fetch_bytes(&agent, &url, MAX_MANIFEST_BYTES, "pack manifest")?,
                None,
                url.to_string(),
            )
        } else {
            let path = PathBuf::from(input);
            let bytes = fs::read(&path)
                .map_err(|error| format!("cannot read manifest '{}': {error}", path.display()))?;
            if bytes.len() as u64 > MAX_MANIFEST_BYTES {
                return Err(format!(
                    "manifest '{}' exceeds the {} byte limit",
                    path.display(),
                    MAX_MANIFEST_BYTES
                ));
            }
            let root = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
            (bytes, Some(root), path.display().to_string())
        };

        let source = std::str::from_utf8(&bytes)
            .map_err(|error| format!("manifest '{source_name}' is not UTF-8: {error}"))?;
        let manifest = PackManifest::from_json(source)
            .map_err(|error| format!("invalid manifest '{source_name}': {error}"))?;
        let remote_base = manifest
            .pack
            .base_url
            .as_deref()
            .map(Url::parse)
            .transpose()
            .map_err(|error| format!("invalid pack.base_url in '{source_name}': {error}"))?;
        if let Some(url) = &remote_base {
            validate_remote_url(url, allow_insecure_http)?;
            if !url.path().ends_with('/') {
                return Err(format!(
                    "pack.base_url in '{source_name}' must end with '/'"
                ));
            }
        }
        if local_root.is_none() && remote_base.is_none() {
            return Err(format!(
                "remote manifest '{source_name}' does not declare pack.base_url"
            ));
        }

        let namespace = manifest.pack.namespace.clone();
        let manifest_digest = format!("{:x}", Sha256::digest(&bytes));
        sources.insert(
            namespace,
            PackSource {
                local_root,
                remote_base,
                manifest_digest,
            },
        );
        manifests.push(manifest);
    }

    let registry = PackRegistry::new(manifests).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; ")
    })?;
    Ok(LoadedPacks { registry, sources })
}

impl LoadedPacks {
    pub fn prepare_roots(
        &self,
        analysis: &AnalyzedDocument,
        cache_dir: &Path,
        allow_insecure_http: bool,
    ) -> Result<HashMap<String, PathBuf>, String> {
        let resolution = analysis
            .resolution
            .as_ref()
            .ok_or_else(|| "pack analysis did not produce resource resolution".to_string())?;
        let mut required = HashMap::<String, HashMap<PathBuf, Option<String>>>::new();
        for resource in &resolution.resources {
            let source = match &resource.kind {
                ResolvedResourceKind::Sticker { source, .. }
                | ResolvedResourceKind::Avatar { source, .. }
                | ResolvedResourceKind::PackAsset { source, .. } => source,
                _ => continue,
            };
            let object = required_object(source)?;
            let entries = required.entry(source.pack_namespace.clone()).or_default();
            match entries.get(&object.relative) {
                Some(existing) if existing != &object.expected_sha256 => {
                    return Err(format!(
                        "pack '{}' assigns conflicting digests to '{}'",
                        source.pack_namespace,
                        object.relative.display()
                    ));
                }
                _ => {
                    entries.insert(object.relative, object.expected_sha256);
                }
            }
        }

        let agent = http_agent();
        let mut roots = HashMap::new();
        for (namespace, pack) in &self.sources {
            let objects = required.remove(namespace).unwrap_or_default();
            let local_complete = pack.local_root.as_ref().is_some_and(|root| {
                objects.keys().all(|relative| {
                    checked_local_path(root, relative).is_ok_and(|path| path.is_file())
                })
            });
            if local_complete {
                roots.insert(namespace.clone(), pack.local_root.clone().unwrap());
                continue;
            }
            if objects.is_empty() {
                if let Some(root) = &pack.local_root {
                    roots.insert(namespace.clone(), root.clone());
                }
                continue;
            }

            let staging_root = cache_dir.join("remote-packs").join(&pack.manifest_digest);
            for (relative, expected_sha256) in objects {
                let destination = staging_root.join(&relative);
                if destination.is_file() {
                    verify_digest_if_present(&destination, expected_sha256.as_deref())?;
                    continue;
                }

                if let Some(local_root) = &pack.local_root
                    && let Ok(local_path) = checked_local_path(local_root, &relative)
                    && local_path.is_file()
                {
                    copy_atomic(&local_path, &destination)?;
                    verify_digest_if_present(&destination, expected_sha256.as_deref())?;
                    continue;
                }

                let base = pack.remote_base.as_ref().ok_or_else(|| {
                    format!(
                        "pack '{namespace}' is missing local resource '{}' and has no pack.base_url",
                        relative.display()
                    )
                })?;
                validate_remote_url(base, allow_insecure_http)?;
                let relative_url = relative.to_str().ok_or_else(|| {
                    format!("pack resource path '{}' is not UTF-8", relative.display())
                })?;
                let url = base.join(relative_url).map_err(|error| {
                    format!("cannot construct URL for '{}': {error}", relative.display())
                })?;
                let bytes = fetch_bytes(&agent, &url, MAX_RESOURCE_BYTES, "pack resource")?;
                verify_bytes_digest(&bytes, expected_sha256.as_deref(), &url)?;
                write_atomic(&destination, &bytes)?;
            }
            roots.insert(namespace.clone(), staging_root);
        }
        Ok(roots)
    }
}

fn required_object(source: &PackStorageSource) -> Result<RequiredObject, String> {
    let (relative, expected_sha256) = match source.storage.kind.as_str() {
        "image-dir" => {
            let path = source.path.as_deref().ok_or_else(|| {
                format!(
                    "image-dir storage '{}::{}' requires a resource path",
                    source.pack_namespace, source.storage_id
                )
            })?;
            let relative = Path::new(source.storage.base.as_deref().unwrap_or("")).join(path);
            let digest = digest_from_file_name(&relative);
            (relative, digest)
        }
        "image-sequence" => {
            let path = source.storage.path.as_deref().ok_or_else(|| {
                format!(
                    "image-sequence storage '{}::{}' requires a container path",
                    source.pack_namespace, source.storage_id
                )
            })?;
            (PathBuf::from(path), source.storage.sha256.clone())
        }
        other => {
            return Err(format!(
                "storage '{}::{}' uses unsupported kind '{other}'",
                source.pack_namespace, source.storage_id
            ));
        }
    };
    validate_relative_path(&relative)?;
    Ok(RequiredObject {
        relative,
        expected_sha256,
    })
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.to_string_lossy().contains('\\')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe pack resource path '{}'", path.display()));
    }
    Ok(())
}

fn checked_local_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve pack root '{}': {error}", root.display()))?;
    let candidate = root.join(relative);
    let resolved = candidate.canonicalize().map_err(|error| {
        format!(
            "cannot resolve pack resource '{}': {error}",
            candidate.display()
        )
    })?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "pack resource '{}' escapes pack root",
            candidate.display()
        ));
    }
    Ok(resolved)
}

fn validate_remote_url(url: &Url, allow_insecure_http: bool) -> Result<(), String> {
    match url.scheme() {
        "https" => Ok(()),
        "http" if allow_insecure_http => Ok(()),
        "http" => Err(format!(
            "refusing insecure pack URL '{url}'; use --allow-insecure-http only for a trusted local server"
        )),
        scheme => Err(format!("unsupported pack URL scheme '{scheme}'")),
    }
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into()
}

fn fetch_bytes(
    agent: &ureq::Agent,
    url: &Url,
    limit: u64,
    description: &str,
) -> Result<Vec<u8>, String> {
    let mut response = agent
        .get(url.as_str())
        .call()
        .map_err(|error| format!("cannot fetch {description} '{url}': {error}"))?;
    if response
        .body()
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!(
            "{description} '{url}' exceeds the {limit} byte limit"
        ));
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {description} '{url}': {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{description} '{url}' exceeds the {limit} byte limit"
        ));
    }
    Ok(bytes)
}

fn digest_from_file_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    (stem.len() == 64 && stem.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| stem.to_ascii_lowercase())
}

fn verify_digest_if_present(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "cannot verify cached resource '{}': {error}",
            path.display()
        )
    })?;
    verify_bytes_digest(&bytes, Some(expected), &path.display().to_string())
}

fn verify_bytes_digest(
    bytes: &[u8],
    expected: Option<&str>,
    source: &impl std::fmt::Display,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!(
            "sha256 mismatch for '{source}': expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|error| {
        format!(
            "cannot read local pack resource '{}': {error}",
            source.display()
        )
    })?;
    write_atomic(destination, &bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path '{}' has no parent", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create pack cache '{}': {error}", parent.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("resource");
    let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("cannot write pack cache '{}': {error}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, path) {
        if path.is_file() {
            let _ = fs::remove_file(&temporary);
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "cannot commit pack cache '{}': {error}",
                path.display()
            ));
        }
    }
    Ok(())
}
