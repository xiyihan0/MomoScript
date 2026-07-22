//! Canonical, host-independent identities for authored sources and derived runtime artifacts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LogicalSourceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceContentKey(pub String);

/// Host-local publication guard. This type is deliberately not accepted by any
/// canonical derived-key constructor.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStaleToken {
    pub host_uri: String,
    pub document_incarnation: String,
    pub document_version: i32,
}

macro_rules! digest_key {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
    };
}

digest_key!(TypstProjectSnapshotKey);
digest_key!(ProjectionKey);
digest_key!(MaterializationKey);
digest_key!(RuntimeArtifactKey);
digest_key!(RenderKey);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LogicalProjectFileId {
    Workspace {
        logical_workspace_id: String,
        canonical_workspace_relative_path: String,
    },
    Package {
        namespace: String,
        name: String,
        version: String,
        package_generation_digest: String,
        canonical_package_relative_path: String,
    },
    Generated {
        dependency_origin: String,
        producer_digest: String,
        canonical_origin_relative_path: String,
    },
}

impl LogicalProjectFileId {
    pub fn workspace(
        logical_workspace_id: impl Into<String>,
        path: impl AsRef<str>,
    ) -> Result<Self, CanonicalIdentityError> {
        Ok(Self::Workspace {
            logical_workspace_id: checked_component(logical_workspace_id.into())?,
            canonical_workspace_relative_path: canonical_relative_path(path.as_ref())?,
        })
    }

    pub fn package(
        namespace: impl Into<String>,
        name: impl Into<String>,
        version: impl Into<String>,
        generation_digest: impl Into<String>,
        path: impl AsRef<str>,
    ) -> Result<Self, CanonicalIdentityError> {
        Ok(Self::Package {
            namespace: checked_component(namespace.into())?,
            name: checked_component(name.into())?,
            version: checked_component(version.into())?,
            package_generation_digest: checked_component(generation_digest.into())?,
            canonical_package_relative_path: canonical_relative_path(path.as_ref())?,
        })
    }

    pub fn generated(
        dependency_origin: impl Into<String>,
        producer_digest: impl Into<String>,
        path: impl AsRef<str>,
    ) -> Result<Self, CanonicalIdentityError> {
        Ok(Self::Generated {
            dependency_origin: checked_component(dependency_origin.into())?,
            producer_digest: checked_component(producer_digest.into())?,
            canonical_origin_relative_path: canonical_relative_path(path.as_ref())?,
        })
    }

    fn write_canonical(&self, writer: &mut CanonicalWriter) {
        match self {
            Self::Workspace {
                logical_workspace_id,
                canonical_workspace_relative_path,
            } => {
                writer.fields([
                    "workspace",
                    logical_workspace_id,
                    canonical_workspace_relative_path,
                ]);
            }
            Self::Package {
                namespace,
                name,
                version,
                package_generation_digest,
                canonical_package_relative_path,
            } => writer.fields([
                "package",
                namespace,
                name,
                version,
                package_generation_digest,
                canonical_package_relative_path,
            ]),
            Self::Generated {
                dependency_origin,
                producer_digest,
                canonical_origin_relative_path,
            } => writer.fields([
                "generated",
                dependency_origin,
                producer_digest,
                canonical_origin_relative_path,
            ]),
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

fn checked_component(value: String) -> Result<String, CanonicalIdentityError> {
    if value.is_empty() {
        return Err(CanonicalIdentityError::EmptySegment);
    }
    if is_uri_like(&value) {
        return Err(CanonicalIdentityError::UriLikeValue);
    }
    Ok(value)
}

fn is_uri_like(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')))
        })
}

pub fn canonical_relative_path(path: &str) -> Result<String, CanonicalIdentityError> {
    if path.starts_with('/') {
        return Err(CanonicalIdentityError::AbsolutePath);
    }
    if path.contains('\\') {
        return Err(CanonicalIdentityError::Backslash);
    }
    if is_uri_like(path) {
        return Err(CanonicalIdentityError::UriLikeValue);
    }
    let mut canonical = String::new();
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(CanonicalIdentityError::EmptySegment);
        }
        if segment == "." || segment == ".." {
            return Err(CanonicalIdentityError::ParentTraversal);
        }
        if !canonical.is_empty() {
            canonical.push('/');
        }
        canonical.push_str(segment);
    }
    Ok(canonical)
}

pub fn logical_source_id(
    workspace_id: impl Into<String>,
    relative_path: impl AsRef<str>,
) -> Result<LogicalSourceId, CanonicalIdentityError> {
    let workspace_id = checked_component(workspace_id.into())?;
    let relative_path = canonical_relative_path(relative_path.as_ref())?;
    let mut writer = CanonicalWriter::new("mmt-logical-source-v1");
    writer.fields([workspace_id.as_str(), relative_path.as_str()]);
    Ok(LogicalSourceId(writer.finish()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDigestInput {
    pub logical_source: LogicalSourceId,
    pub source_content: SourceContentKey,
    pub entry_file: LogicalProjectFileId,
    pub files: BTreeMap<LogicalProjectFileId, String>,
    pub package_generations: BTreeMap<String, String>,
    pub generated_dependencies: BTreeMap<String, String>,
    pub project_options: BTreeMap<String, String>,
    pub source_map_digest: String,
}

pub fn source_content_key(logical_source: &LogicalSourceId, source: &[u8]) -> SourceContentKey {
    SourceContentKey(canonical_bytes_digest(
        "mmt-source-content-v1",
        &[logical_source.0.as_bytes(), source],
    ))
}

pub fn project_snapshot_key(input: &ProjectDigestInput) -> TypstProjectSnapshotKey {
    let mut writer = CanonicalWriter::new("mmt-typst-project-v1");
    writer.field(input.logical_source.0.as_bytes());
    writer.field(input.source_content.0.as_bytes());
    input.entry_file.write_canonical(&mut writer);
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

pub fn projection_key(
    source: &SourceContentKey,
    session: &str,
    revision: u64,
    logical_entry_id: &LogicalProjectFileId,
    project_digest: &TypstProjectSnapshotKey,
    mapping_digest: &str,
) -> ProjectionKey {
    let mut writer = CanonicalWriter::new("mmt-projection-key-v1");
    writer.fields([source.0.as_str(), session, &revision.to_string()]);
    logical_entry_id.write_canonical(&mut writer);
    writer.fields([project_digest.0.as_str(), mapping_digest]);
    ProjectionKey(writer.finish())
}

pub fn materialization_key(
    projection: &ProjectionKey,
    pack_registry_digest: &str,
    resource_plan_digest: &str,
    resource_bytes_digest: &str,
) -> MaterializationKey {
    MaterializationKey(derived_key(
        "mmt-materialization-key-v1",
        &[
            projection.0.as_str(),
            pack_registry_digest,
            resource_plan_digest,
            resource_bytes_digest,
        ],
    ))
}

pub fn runtime_artifact_key(
    typst_compiler_version: &str,
    typst_wasm_digest: &str,
    template_bundle_digest: &str,
    font_set_digest: &str,
) -> RuntimeArtifactKey {
    RuntimeArtifactKey(derived_key(
        "mmt-runtime-artifact-v2",
        &[
            typst_compiler_version,
            typst_wasm_digest,
            template_bundle_digest,
            font_set_digest,
        ],
    ))
}

pub fn render_key(
    materialization: &MaterializationKey,
    runtime: &RuntimeArtifactKey,
    render_options_digest: &str,
) -> RenderKey {
    RenderKey(derived_key(
        "mmt-render-key-v1",
        &[
            materialization.0.as_str(),
            runtime.0.as_str(),
            render_options_digest,
        ],
    ))
}

pub fn derived_key(domain: &str, fields: &[&str]) -> String {
    canonical_bytes_digest(
        domain,
        &fields
            .iter()
            .map(|field| field.as_bytes())
            .collect::<Vec<_>>(),
    )
}

pub fn canonical_bytes_digest(domain: &str, fields: &[&[u8]]) -> String {
    let mut writer = CanonicalWriter::new(domain);
    for field in fields {
        writer.field(field);
    }
    writer.finish()
}

pub fn canonical_json_digest(domain: &str, value: &serde_json::Value) -> String {
    fn write_json(writer: &mut CanonicalWriter, value: &serde_json::Value) {
        match value {
            serde_json::Value::Null => writer.field(b"null"),
            serde_json::Value::Bool(value) => {
                writer.fields(["bool", if *value { "true" } else { "false" }])
            }
            serde_json::Value::Number(value) => writer.fields(["number", &value.to_string()]),
            serde_json::Value::String(value) => writer.fields(["string", value]),
            serde_json::Value::Array(values) => {
                writer.fields(["array", &values.len().to_string()]);
                for value in values {
                    write_json(writer, value);
                }
            }
            serde_json::Value::Object(values) => {
                writer.fields(["object", &values.len().to_string()]);
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_by(|(left, _), (right, _)| left.cmp(right));
                for (key, value) in entries {
                    writer.field(key.as_bytes());
                    write_json(writer, value);
                }
            }
        }
    }

    let mut writer = CanonicalWriter::new(domain);
    write_json(&mut writer, value);
    writer.finish()
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
        for value in values {
            self.field(value.as_bytes());
        }
    }

    fn map<K: Ord, V>(&mut self, map: &BTreeMap<K, V>, mut write: impl FnMut(&mut Self, &K, &V)) {
        self.field(&(map.len() as u64).to_be_bytes());
        for (key, value) in map {
            write(self, key, value);
        }
    }

    fn string_map(&mut self, map: &BTreeMap<String, String>) {
        self.map(map, |writer, key, value| {
            writer.fields([key.as_str(), value.as_str()]);
        });
    }

    fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ProjectDigestInput {
        let logical_source = logical_source_id("workspace", "故事/晴.mmt").unwrap();
        let source_content = source_content_key(&logical_source, "晴e\u{301}😀".as_bytes());
        let entry_file =
            LogicalProjectFileId::generated("authored", "producer-v1", "main.typ").unwrap();
        let files = BTreeMap::from([
            (
                entry_file.clone(),
                canonical_bytes_digest("mmt-file-v1", &[b"hello"]),
            ),
            (
                LogicalProjectFileId::workspace("workspace", "assets/avatar.png").unwrap(),
                canonical_bytes_digest("mmt-file-v1", &[b"png"]),
            ),
            (
                LogicalProjectFileId::package("preview", "theme", "1.0.0", "pack-gen", "lib.typ")
                    .unwrap(),
                canonical_bytes_digest("mmt-file-v1", &[b"theme"]),
            ),
        ]);
        ProjectDigestInput {
            logical_source,
            source_content,
            entry_file,
            files,
            package_generations: BTreeMap::from([(
                "preview/theme:1.0.0".into(),
                "pack-gen".into(),
            )]),
            generated_dependencies: BTreeMap::from([("template".into(), "template-gen".into())]),
            project_options: BTreeMap::from([("compiledAt".into(), "none".into())]),
            source_map_digest: derived_key("mmt-source-map-v1", &["identity"]),
        }
    }

    #[test]
    fn canonical_keys_are_complete_and_local_stale_state_is_not_an_input() {
        let input = fixture();
        let project = project_snapshot_key(&input);
        let projection = projection_key(
            &input.source_content,
            "session-a",
            7,
            &input.entry_file,
            &project,
            &input.source_map_digest,
        );
        let materialization = materialization_key(&projection, "pack", "plan", "bytes");
        let runtime =
            runtime_artifact_key("0.15.2", "compiler-wasm", "template", "fonts");
        let render = render_key(&materialization, &runtime, "options");
        assert_eq!(project.0.len(), 64);
        assert_eq!(projection.0.len(), 64);
        assert_eq!(render.0.len(), 64);

        let first_guard = SourceStaleToken {
            host_uri: "file:///workspace/故事/晴.mmt".into(),
            document_incarnation: "open-1".into(),
            document_version: 1,
        };
        let second_guard = SourceStaleToken {
            host_uri: "mmtfs://workspace/故事/晴.mmt".into(),
            document_incarnation: "open-2".into(),
            document_version: 99,
        };
        assert_ne!(first_guard, second_guard);
        assert_eq!(render, render_key(&materialization, &runtime, "options"));
    }

    #[test]
    fn canonical_project_is_order_independent_and_rejects_presentation_uris() {
        let input = fixture();
        let mut reversed = input.clone();
        reversed.files = input
            .files
            .iter()
            .rev()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        reversed.project_options = input
            .project_options
            .iter()
            .rev()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        assert_eq!(
            project_snapshot_key(&input),
            project_snapshot_key(&reversed)
        );
        assert_eq!(
            LogicalProjectFileId::workspace("workspace", "file:/tmp/main.typ"),
            Err(CanonicalIdentityError::UriLikeValue)
        );
        assert_eq!(
            LogicalProjectFileId::workspace("workspace", "mmtfs://workspace/main.typ"),
            Err(CanonicalIdentityError::UriLikeValue)
        );
        assert_eq!(
            LogicalProjectFileId::workspace("workspace", "dir\\main.typ"),
            Err(CanonicalIdentityError::Backslash)
        );
    }
}
