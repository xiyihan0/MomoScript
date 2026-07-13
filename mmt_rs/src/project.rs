//! Native filesystem support for exporting a self-contained Typst project.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::materialize::{MaterializeError, MaterializedImage, ResourceMaterializer};
use crate::resolve::{PackStorageSource, ResolvedResource, ResolvedResourceKind};
use crate::semantic::AssetSource;

#[derive(Debug, Clone)]
pub struct ProjectMaterializerOptions {
    pub output_dir: PathBuf,
    pub workspace_root: PathBuf,
    pub pack_roots: HashMap<String, PathBuf>,
    pub cache_dir: PathBuf,
    pub avifdec_bin: PathBuf,
    pub decoder_profile: String,
}

pub struct ProjectMaterializer {
    options: ProjectMaterializerOptions,
    copied: HashMap<PathBuf, String>,
    verified_sequences: HashSet<(PathBuf, String)>,
    next_id: usize,
}

impl ProjectMaterializer {
    pub fn new(options: ProjectMaterializerOptions) -> Result<Self, MaterializeError> {
        fs::create_dir_all(options.output_dir.join("assets")).map_err(|error| {
            MaterializeError::new(format!("cannot create project assets: {error}"))
        })?;
        Ok(Self {
            options,
            copied: HashMap::new(),
            verified_sequences: HashSet::new(),
            next_id: 0,
        })
    }

    fn source_path(&self, resource: &ResolvedResource) -> Result<PathBuf, MaterializeError> {
        match &resource.kind {
            ResolvedResourceKind::Sticker { source, .. }
            | ResolvedResourceKind::Avatar { source, .. }
            | ResolvedResourceKind::PackAsset { source, .. } => self.pack_image_path(source),
            ResolvedResourceKind::ScriptAsset { source, .. } => match source {
                AssetSource::LocalFile(path) => Ok(self.options.workspace_root.join(path)),
                AssetSource::Url(_) => Err(MaterializeError::new(
                    "remote script assets are not supported by the project exporter",
                )),
            },
            ResolvedResourceKind::WorkspaceFile { path } => {
                Ok(self.options.workspace_root.join(path))
            }
            ResolvedResourceKind::RemoteUrl { .. } => Err(MaterializeError::new(
                "remote resources are not supported by the project exporter",
            )),
            ResolvedResourceKind::Temporary { .. } => Err(MaterializeError::new(
                "temporary resources require a host-provided materializer",
            )),
        }
    }

    fn pack_root(&self, namespace: &str) -> Result<PathBuf, MaterializeError> {
        self.options
            .pack_roots
            .get(namespace)
            .ok_or_else(|| {
                MaterializeError::new(format!(
                    "no filesystem root registered for pack '{namespace}'"
                ))
            })?
            .canonicalize()
            .map_err(|error| {
                MaterializeError::new(format!(
                    "cannot resolve filesystem root for pack '{namespace}': {error}"
                ))
            })
    }

    fn checked_pack_path(
        &self,
        source: &PackStorageSource,
        relative: &Path,
    ) -> Result<PathBuf, MaterializeError> {
        let root = self.pack_root(&source.pack_namespace)?;
        let path = root.join(relative).canonicalize().map_err(|error| {
            MaterializeError::new(format!(
                "cannot read pack resource '{}': {error}",
                root.join(relative).display()
            ))
        })?;
        if !path.starts_with(&root) {
            return Err(MaterializeError::new(format!(
                "pack resource '{}' escapes pack root",
                path.display()
            )));
        }
        Ok(path)
    }

    fn pack_image_path(&self, source: &PackStorageSource) -> Result<PathBuf, MaterializeError> {
        if source.storage.kind != "image-dir" {
            return Err(MaterializeError::new(format!(
                "storage '{}::{}' uses unsupported kind '{}' for direct image copying",
                source.pack_namespace, source.storage_id, source.storage.kind
            )));
        }
        let base = source.storage.base.as_deref().unwrap_or("");
        let path = source.path.as_deref().ok_or_else(|| {
            MaterializeError::new(format!(
                "image-dir storage '{}::{}' requires a resource path",
                source.pack_namespace, source.storage_id
            ))
        })?;
        self.checked_pack_path(source, &Path::new(base).join(path))
    }

    fn materialize_sequence(
        &mut self,
        source: &PackStorageSource,
    ) -> Result<MaterializedImage, MaterializeError> {
        let container = source.storage.path.as_deref().ok_or_else(|| {
            MaterializeError::new("image-sequence storage requires a container path")
        })?;
        let frame = source.frame.ok_or_else(|| {
            MaterializeError::new("image-sequence resource requires a frame index")
        })?;
        let frame_count = source
            .storage
            .frame_count
            .ok_or_else(|| MaterializeError::new("image-sequence storage requires frame_count"))?;
        if frame >= frame_count {
            return Err(MaterializeError::new(format!(
                "frame {frame} is outside image-sequence frame_count {frame_count}"
            )));
        }
        let sha256 = source
            .storage
            .sha256
            .as_deref()
            .ok_or_else(|| MaterializeError::new("image-sequence storage requires sha256"))?;
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MaterializeError::new(
                "image-sequence sha256 must contain 64 hexadecimal characters",
            ));
        }
        if !self
            .options
            .decoder_profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(MaterializeError::new(
                "decoder profile may only contain ASCII letters, digits, '.', '-' and '_'",
            ));
        }
        let [width, height] = source
            .storage
            .size
            .ok_or_else(|| MaterializeError::new("image-sequence storage requires output size"))?;
        let cache_name = format!(
            "{}-f{frame}-{}-png-{width}x{height}.png",
            sha256.to_ascii_lowercase(),
            self.options.decoder_profile
        );
        let cache_path = self.options.cache_dir.join(cache_name);
        let input = self.checked_pack_path(source, Path::new(container))?;
        let verification = (input.clone(), sha256.to_ascii_lowercase());
        if !self.verified_sequences.contains(&verification) {
            verify_sha256(&input, sha256)?;
            self.verified_sequences.insert(verification);
        }
        if !cache_path.is_file() {
            fs::create_dir_all(&self.options.cache_dir).map_err(|error| {
                MaterializeError::new(format!("cannot create decoder cache: {error}"))
            })?;
            let temporary = cache_path.with_file_name(format!(
                ".{}.{}.tmp.png",
                cache_path.file_name().unwrap().to_string_lossy(),
                std::process::id()
            ));
            let pixel_limit = width.checked_mul(height).ok_or_else(|| {
                MaterializeError::new("image-sequence dimensions overflow the decoder limit")
            })?;
            let dimension_limit = width.max(height);
            let output = Command::new(&self.options.avifdec_bin)
                .args(["-j", "1", "-c", "dav1d", "--index"])
                .arg(frame.to_string())
                .arg("--dimension-limit")
                .arg(dimension_limit.to_string())
                .arg("--size-limit")
                .arg(pixel_limit.to_string())
                .arg("--")
                .arg(&input)
                .arg(&temporary)
                .output()
                .map_err(|error| {
                    MaterializeError::new(format!(
                        "cannot run '{}': {error}",
                        self.options.avifdec_bin.display()
                    ))
                })?;
            if !output.status.success() {
                let _ = fs::remove_file(&temporary);
                return Err(MaterializeError::new(format!(
                    "dav1d AVIFS decode failed for frame {frame}: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            validate_png(&temporary, width, height)?;
            if let Err(error) = fs::rename(&temporary, &cache_path) {
                if cache_path.is_file() {
                    let _ = fs::remove_file(&temporary);
                    validate_png(&cache_path, width, height)?;
                } else {
                    let _ = fs::remove_file(&temporary);
                    return Err(MaterializeError::new(format!(
                        "cannot commit decoded frame cache: {error}"
                    )));
                }
            }
        } else {
            validate_png(&cache_path, width, height)?;
        }
        self.copy_asset(cache_path)
    }

    fn copy_asset(&mut self, source: PathBuf) -> Result<MaterializedImage, MaterializeError> {
        let source = source.canonicalize().map_err(|error| {
            MaterializeError::new(format!(
                "cannot read resource '{}': {error}",
                source.display()
            ))
        })?;
        if let Some(path) = self.copied.get(&source) {
            return Ok(MaterializedImage {
                typst_path: path.clone(),
            });
        }
        if !source.is_file() {
            return Err(MaterializeError::new(format!(
                "resource '{}' is not a file",
                source.display()
            )));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| value.chars().all(|ch| ch.is_ascii_alphanumeric()))
            .unwrap_or("bin");
        let relative = format!("assets/{:06}.{extension}", self.next_id);
        self.next_id += 1;
        fs::copy(&source, self.options.output_dir.join(&relative)).map_err(|error| {
            MaterializeError::new(format!(
                "cannot copy resource '{}': {error}",
                source.display()
            ))
        })?;
        self.copied.insert(source, relative.clone());
        Ok(MaterializedImage {
            typst_path: relative,
        })
    }
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), MaterializeError> {
    let bytes = fs::read(path).map_err(|error| {
        MaterializeError::new(format!("cannot hash AVIFS '{}': {error}", path.display()))
    })?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(MaterializeError::new(format!(
            "AVIFS sha256 mismatch for '{}': expected {expected}, got {actual}",
            path.display()
        )));
    }
    Ok(())
}

impl ResourceMaterializer for ProjectMaterializer {
    fn materialize(
        &mut self,
        resource: &ResolvedResource,
    ) -> Result<MaterializedImage, MaterializeError> {
        match &resource.kind {
            ResolvedResourceKind::Sticker { source, .. }
            | ResolvedResourceKind::Avatar { source, .. }
            | ResolvedResourceKind::PackAsset { source, .. }
                if source.storage.kind == "image-sequence" =>
            {
                self.materialize_sequence(source)
            }
            _ => {
                let source = self.source_path(resource)?;
                self.copy_asset(source)
            }
        }
    }
}

fn validate_png(
    path: &Path,
    expected_width: u32,
    expected_height: u32,
) -> Result<(), MaterializeError> {
    let bytes = fs::read(path).map_err(|error| {
        MaterializeError::new(format!(
            "cannot read decoded PNG '{}': {error}",
            path.display()
        ))
    })?;
    if bytes.len() < 26 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err(MaterializeError::new(format!(
            "decoder output '{}' is not a valid PNG",
            path.display()
        )));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if [width, height] != [expected_width, expected_height] {
        return Err(MaterializeError::new(format!(
            "decoded PNG size {width}x{height} does not match manifest {expected_width}x{expected_height}"
        )));
    }
    Ok(())
}

pub fn export_template_library(source: &Path, output_dir: &Path) -> Result<(), MaterializeError> {
    let target = output_dir.join("template");
    copy_template_tree(source, &target)
}

fn copy_template_tree(source: &Path, target: &Path) -> Result<(), MaterializeError> {
    fs::create_dir_all(target).map_err(|error| {
        MaterializeError::new(format!("cannot create template directory: {error}"))
    })?;
    let entries = fs::read_dir(source).map_err(|error| {
        MaterializeError::new(format!("cannot read template directory: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| MaterializeError::new(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| MaterializeError::new(error.to_string()))?;
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_template_tree(&path, &destination)?;
        } else if file_type.is_file()
            && (matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("typ" | "webp" | "wasm" | "toml")
            ) || entry.file_name() == "LICENSE")
        {
            fs::copy(&path, &destination).map_err(|error| {
                MaterializeError::new(format!(
                    "cannot copy template '{}': {error}",
                    path.display()
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack::StorageEntry;
    use crate::resolve::{PackStorageSource, ResolvedResourceKind, ResourceTarget};
    use crate::source::TextRange;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mmt-project-{name}-{}", std::process::id()))
    }

    #[test]
    fn copies_workspace_files_to_stable_project_paths() {
        let root = temp_dir("copy");
        let output = root.join("output");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("image.svg"), "<svg/>").unwrap();
        let mut materializer = ProjectMaterializer::new(ProjectMaterializerOptions {
            output_dir: output.clone(),
            workspace_root: root.clone(),
            pack_roots: HashMap::new(),
            cache_dir: root.join("cache"),
            avifdec_bin: PathBuf::from("avifdec"),
            decoder_profile: "test".to_string(),
        })
        .unwrap();
        let resource = ResolvedResource {
            range: TextRange::new(0, 1),
            target: ResourceTarget::Inline,
            kind: ResolvedResourceKind::WorkspaceFile {
                path: "image.svg".to_string(),
            },
            render_patch: None,
        };

        let first = materializer.materialize(&resource).unwrap();
        let second = materializer.materialize(&resource).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.typst_path, "assets/000000.svg");
        assert!(output.join(first.typst_path).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn decodes_and_caches_an_alpha_avifs_frame_with_dav1d() {
        let root = temp_dir("sequence");
        let fixture_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/avifs");
        let mut pack_roots = HashMap::new();
        pack_roots.insert("ba".to_string(), fixture_root);
        let output = root.join("output");
        let cache = root.join("cache");
        let mut materializer = ProjectMaterializer::new(ProjectMaterializerOptions {
            output_dir: output.clone(),
            workspace_root: root.clone(),
            pack_roots,
            cache_dir: cache.clone(),
            avifdec_bin: PathBuf::from("avifdec"),
            decoder_profile: "test".to_string(),
        })
        .unwrap();
        let resource = ResolvedResource {
            range: TextRange::new(0, 1),
            target: ResourceTarget::Inline,
            kind: ResolvedResourceKind::Sticker {
                entity_id: "ba::佳代子".to_string(),
                contribution_namespace: "ba".to_string(),
                set_id: "default".to_string(),
                variant_id: "default_001".to_string(),
                source: PackStorageSource {
                    pack_namespace: "ba".to_string(),
                    storage_id: "stickers".to_string(),
                    storage: StorageEntry {
                        kind: "image-sequence".to_string(),
                        base: None,
                        path: Some("alpha-sequence.avifs".to_string()),
                        container: Some("avifs".to_string()),
                        codec: Some("av1".to_string()),
                        alpha: Some(true),
                        frame_count: Some(28),
                        fps: Some(1),
                        size: Some([1002, 896]),
                        profile: None,
                        random_access: None,
                        sha256: Some(
                            "a3d12e6399f79b05ddd33fb30a42190702f0954a61a19af93d0d329d909d2123"
                                .to_string(),
                        ),
                    },
                    path: None,
                    frame: Some(0),
                },
            },
            render_patch: None,
        };

        let first = materializer.materialize(&resource).unwrap();
        let second = materializer.materialize(&resource).unwrap();

        assert_eq!(first, second);
        let png = fs::read(output.join(&first.typst_path)).unwrap();
        assert_eq!(png[25], 6, "transparent fixture must remain RGBA PNG");
        assert_eq!(fs::read_dir(cache).unwrap().count(), 1);

        let mut bad_hash = resource.clone();
        let ResolvedResourceKind::Sticker { source, .. } = &mut bad_hash.kind else {
            unreachable!()
        };
        source.storage.sha256 = Some("0".repeat(64));
        let error = materializer.materialize(&bad_hash).unwrap_err();
        assert!(error.message.contains("AVIFS sha256 mismatch"));
        fs::remove_dir_all(root).unwrap();
    }
}
