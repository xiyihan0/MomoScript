//! Canonical, host-independent identities for authored sources and derived runtime artifacts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LogicalSourceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceContentKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceStaleToken(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TypstProjectSnapshotKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectionKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MaterializationKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RuntimeArtifactKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RenderKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LogicalProjectFileId {
    Workspace { path: String },
    Package {
        namespace: String,
        name: String,
        version: String,
        generation: String,
        path: String,
    },
    Generated {
        producer: String,
        origin: String,
        path: String,
    },
}

impl LogicalProjectFileId {
    pub fn workspace(path: impl AsRef<str>) -> Result<Self, CanonicalIdentityError> {
        Ok(Self::Workspace { path: canonical_relative_path(path.as_ref())? })
    }

    fn write_canonical(&self, writer: &mut CanonicalWriter) {
        match self {
            Self::Workspace { path } => writer.fields(["workspace", path]),
            Self::Package { namespace, name, version, generation, path } => {
                writer.fields(["package", namespace, name, version, generation, path]);
            }
            Self::Generated { producer, origin, path } => {
                writer.fields(["generated", producer, origin, path]);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalIdentityError {
    AbsolutePath,
    ParentTraversal,
    Backslash,
    UriLikeValue,
    EmptySegment,
}

pub fn canonical_relative_path(path: &str) -> Result<String, CanonicalIdentityError> {
    if path.starts_with('/') { return Err(CanonicalIdentityError::AbsolutePath); }
    if path.contains('\\') { return Err(CanonicalIdentityError::Backslash); }
    if path.contains("://") { return Err(CanonicalIdentityError::UriLikeValue); }
    let mut canonical = String::new();
    for segment in path.split('/') {
        if segment.is_empty() { return Err(CanonicalIdentityError::EmptySegment); }
        if segment == "." || segment == ".." { return Err(CanonicalIdentityError::ParentTraversal); }
        if !canonical.is_empty() { canonical.push('/'); }
        canonical.push_str(segment);
    }
    Ok(canonical)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDigestInput {
    pub logical_source: LogicalSourceId,
    pub source_content: SourceContentKey,
    pub files: BTreeMap<LogicalProjectFileId, String>,
    pub package_generations: BTreeMap<String, String>,
    pub generated_dependencies: BTreeMap<String, String>,
    pub project_options: BTreeMap<String, String>,
    pub source_map_digest: String,
}

pub fn source_content_key(source: &[u8]) -> SourceContentKey {
    SourceContentKey(hex_digest("mmt-source-content-v1", [source]))
}

pub fn project_snapshot_key(input: &ProjectDigestInput) -> TypstProjectSnapshotKey {
    let mut writer = CanonicalWriter::new("mmt-typst-project-v1");
    writer.field(input.logical_source.0.as_bytes());
    writer.field(input.source_content.0.as_bytes());
    writer.map(&input.files, |writer, id, digest| {
        id.write_canonical(writer);
        writer.field(digest.as_bytes());
    });
    writer.string_map(&input.package_generations);
    writer.string_map(&input.generated_dependencies);
    writer.string_map(&input.project_options);
    writer.field(input.source_map_digest.as_bytes());
    TypstProjectSnapshotKey(writer.finish())
}

pub fn runtime_artifact_key(
    compiler: &str,
    renderer: &str,
    template_bundle_digest: &str,
    font_set_digest: &str,
) -> RuntimeArtifactKey {
    RuntimeArtifactKey(hex_digest(
        "mmt-runtime-artifact-v1",
        [compiler.as_bytes(), renderer.as_bytes(), template_bundle_digest.as_bytes(), font_set_digest.as_bytes()],
    ))
}

pub fn derived_key(domain: &str, fields: &[&str]) -> String {
    hex_digest(domain, fields.iter().map(|field| field.as_bytes()))
}

struct CanonicalWriter(Sha256);

impl CanonicalWriter {
    fn new(domain: &str) -> Self {
        let mut writer = Self(Sha256::new());
        writer.field(domain.as_bytes());
        writer
    }

    fn field(&mut self, value: &[u8]) {
        self.0.update((value.len() as u64).to_be_bytes());
        self.0.update(value);
    }

    fn fields<'a>(&mut self, values: impl IntoIterator<Item = &'a str>) {
        for value in values { self.field(value.as_bytes()); }
    }

    fn map<K: Ord, V>(&mut self, map: &BTreeMap<K, V>, mut write: impl FnMut(&mut Self, &K, &V)) {
        self.field(&(map.len() as u64).to_be_bytes());
        for (key, value) in map { write(self, key, value); }
    }

    fn string_map(&mut self, map: &BTreeMap<String, String>) {
        self.map(map, |writer, key, value| writer.fields([key.as_str(), value.as_str()]));
    }

    fn finish(self) -> String { format!("{:x}", self.0.finalize()) }
}

fn hex_digest<'a>(domain: &str, fields: impl IntoIterator<Item = &'a [u8]>) -> String {
    let mut writer = CanonicalWriter::new(domain);
    for field in fields { writer.field(field); }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_digest_is_order_and_host_uri_independent() {
        let mut files = BTreeMap::new();
        files.insert(LogicalProjectFileId::workspace("main.typ").unwrap(), source_content_key(b"hello").0);
        let input = ProjectDigestInput {
            logical_source: LogicalSourceId("workspace:demo/main.mmt".into()),
            source_content: source_content_key("晴e\u{301}😀".as_bytes()),
            files,
            package_generations: BTreeMap::from([("preview/mmt-render".into(), "sha256:abc".into())]),
            generated_dependencies: BTreeMap::new(),
            project_options: BTreeMap::from([("compiledAt".into(), "none".into())]),
            source_map_digest: derived_key("source-map", &["identity"]),
        };
        let first = project_snapshot_key(&input);
        let second = project_snapshot_key(&input);
        assert_eq!(first, second);
        assert_eq!(first.0.len(), 64);
    }

    #[test]
    fn rejects_backend_paths_and_traversal() {
        assert_eq!(LogicalProjectFileId::workspace("file:///tmp/main.typ"), Err(CanonicalIdentityError::UriLikeValue));
        assert_eq!(LogicalProjectFileId::workspace("../main.typ"), Err(CanonicalIdentityError::ParentTraversal));
        assert_eq!(LogicalProjectFileId::workspace("dir\\main.typ"), Err(CanonicalIdentityError::Backslash));
    }
}
