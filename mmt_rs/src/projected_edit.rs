//! Fail-closed validation for edits returned against retained projected documents.
//!
//! This module validates and maps edits only. Applying the returned authored byte
//! ranges is deliberately a separate host responsibility.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::identity::{ProjectionKey, SourceContentKey};
use crate::projection::{ProjectionIndex, ProjectionMappingKind};
use crate::source::TextRange;

pub const PROJECTED_EDIT_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectedEditEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16")]
    Utf16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEditPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEditRange {
    pub start: ProjectedEditPosition,
    pub end: ProjectedEditPosition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEditDocumentIdentity {
    pub virtual_uri: String,
    pub source_content: SourceContentKey,
    pub projection_key: ProjectionKey,
    pub encoding: ProjectedEditEncoding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTextEdit {
    pub virtual_uri: String,
    pub range: ProjectedEditRange,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTargetVersion {
    pub uri: String,
    pub version: i32,
}

/// Versioned wire transaction. Every virtual document identity names the exact
/// retained bytes and source map against which backend positions were produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEditTransaction {
    pub protocol_version: u32,
    pub documents: Vec<ProjectedEditDocumentIdentity>,
    pub edits: Vec<ProjectedTextEdit>,
    pub expected_versions: Vec<ProjectedTargetVersion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectedTargetClass {
    Authored,
    Template,
    Package,
    GeneratedWrapper,
    MaterializedResource,
    ReadOnlyVirtual,
}

/// One exact retained projection. The borrowed text and index must be from the
/// same immutable generation named by `source_content` and `projection_key`.
pub struct RetainedProjectedDocument<'a> {
    pub virtual_uri: &'a str,
    pub source_content: &'a SourceContentKey,
    pub projection_key: &'a ProjectionKey,
    pub source: &'a str,
    pub index: &'a ProjectionIndex,
    pub authored_target_uri: &'a str,
    pub current: bool,
}

pub struct ProjectedEditTarget<'a> {
    pub uri: &'a str,
    pub version: i32,
    pub class: ProjectedTargetClass,
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ProjectedEditFailure {
    #[serde(rename = "UnsafeEdit")]
    UnsafeEdit { reason: UnsafeEditReason },
    #[serde(rename = "StaleProjection")]
    StaleProjection { reason: StaleProjectionReason },
    #[serde(rename = "ReadOnlyTarget")]
    ReadOnlyTarget { uri: String },
    #[serde(rename = "CapabilityUnavailable")]
    CapabilityUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsafeEditReason {
    UnsupportedProtocolVersion,
    InvalidUri,
    DuplicateUri,
    MissingDocumentIdentity,
    InvalidPosition,
    ReversedRange,
    CrossSegment,
    NonIdentityMapping,
    MissingExpectedVersion,
    OverlappingEdits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StaleProjectionReason {
    MissingRetainedDocument,
    IdentityMismatch,
    RetiredProjection,
    DocumentVersionChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProjectedEdit<'a> {
    pub range: TextRange,
    pub new_text: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProjectedDocumentEdits<'a> {
    pub normalized_uri: String,
    pub expected_version: i32,
    pub edits: Vec<ValidatedProjectedEdit<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProjectedEditTransaction<'a> {
    pub documents: Vec<ValidatedProjectedDocumentEdits<'a>>,
}

/// Validates the complete transaction before returning any mapped edit. The
/// caller receives no partial result when any edit or target is unsafe.
pub fn validate_projected_edit_transaction<'a>(
    transaction: &'a ProjectedEditTransaction,
    retained: &[RetainedProjectedDocument<'_>],
    targets: &[ProjectedEditTarget<'_>],
    capability_available: bool,
) -> Result<ValidatedProjectedEditTransaction<'a>, ProjectedEditFailure> {
    if !capability_available {
        return Err(ProjectedEditFailure::CapabilityUnavailable);
    }
    if transaction.protocol_version != PROJECTED_EDIT_PROTOCOL_VERSION {
        return Err(unsafe_edit(UnsafeEditReason::UnsupportedProtocolVersion));
    }

    let mut identities = BTreeMap::new();
    for identity in &transaction.documents {
        let uri = normalize_uri(&identity.virtual_uri)?;
        if identities.insert(uri, identity).is_some() {
            return Err(unsafe_edit(UnsafeEditReason::DuplicateUri));
        }
    }

    let mut retained_by_uri = BTreeMap::new();
    for document in retained {
        let uri = normalize_uri(document.virtual_uri)?;
        if retained_by_uri.insert(uri, document).is_some() {
            return Err(unsafe_edit(UnsafeEditReason::DuplicateUri));
        }
    }

    let mut target_by_uri = BTreeMap::new();
    for target in targets {
        let uri = normalize_uri(target.uri)?;
        if target_by_uri.insert(uri, target).is_some() {
            return Err(unsafe_edit(UnsafeEditReason::DuplicateUri));
        }
    }

    let mut expected_versions = BTreeMap::new();
    for expected in &transaction.expected_versions {
        let uri = normalize_uri(&expected.uri)?;
        if expected_versions.insert(uri, expected.version).is_some() {
            return Err(unsafe_edit(UnsafeEditReason::DuplicateUri));
        }
    }

    let mut mapped: BTreeMap<String, Vec<ValidatedProjectedEdit<'a>>> = BTreeMap::new();
    for edit in &transaction.edits {
        let virtual_uri = normalize_uri(&edit.virtual_uri)?;
        let identity = identities
            .get(&virtual_uri)
            .ok_or_else(|| unsafe_edit(UnsafeEditReason::MissingDocumentIdentity))?;
        let document =
            retained_by_uri
                .get(&virtual_uri)
                .ok_or(ProjectedEditFailure::StaleProjection {
                    reason: StaleProjectionReason::MissingRetainedDocument,
                })?;
        if !document.current {
            return Err(ProjectedEditFailure::StaleProjection {
                reason: StaleProjectionReason::RetiredProjection,
            });
        }
        if identity.source_content != *document.source_content
            || identity.projection_key != *document.projection_key
        {
            return Err(ProjectedEditFailure::StaleProjection {
                reason: StaleProjectionReason::IdentityMismatch,
            });
        }

        let projected_range = decode_range(document.source, edit.range, identity.encoding)?;
        let mapping = document.index.classify_read(projected_range);
        match mapping.kind {
            ProjectionMappingKind::AuthoredIdentity => {}
            ProjectionMappingKind::StaleUnknown => {
                return Err(unsafe_edit(UnsafeEditReason::CrossSegment));
            }
            ProjectionMappingKind::WorkspaceTypst
            | ProjectionMappingKind::PackageFile
            | ProjectionMappingKind::GeneratedProjection => {
                return Err(ProjectedEditFailure::ReadOnlyTarget {
                    uri: normalize_uri(document.authored_target_uri)?,
                });
            }
        }
        let source_range = mapping
            .source_range
            .ok_or_else(|| unsafe_edit(UnsafeEditReason::CrossSegment))?;
        let target_uri = normalize_uri(document.authored_target_uri)?;
        let target =
            target_by_uri
                .get(&target_uri)
                .ok_or_else(|| ProjectedEditFailure::ReadOnlyTarget {
                    uri: target_uri.clone(),
                })?;
        if target.class != ProjectedTargetClass::Authored || !target.writable {
            return Err(ProjectedEditFailure::ReadOnlyTarget { uri: target_uri });
        }
        let expected_version = expected_versions
            .get(&target_uri)
            .ok_or_else(|| unsafe_edit(UnsafeEditReason::MissingExpectedVersion))?;
        if *expected_version != target.version {
            return Err(ProjectedEditFailure::StaleProjection {
                reason: StaleProjectionReason::DocumentVersionChanged,
            });
        }
        mapped
            .entry(target_uri)
            .or_default()
            .push(ValidatedProjectedEdit {
                range: source_range,
                new_text: &edit.new_text,
            });
    }

    let edited_targets: BTreeSet<_> = mapped.keys().cloned().collect();
    if expected_versions
        .keys()
        .any(|uri| !edited_targets.contains(uri))
    {
        return Err(unsafe_edit(UnsafeEditReason::MissingExpectedVersion));
    }

    let mut documents = Vec::with_capacity(mapped.len());
    for (uri, mut edits) in mapped {
        edits.sort_unstable_by_key(|edit| (edit.range.start, edit.range.end));
        if edits
            .windows(2)
            .any(|pair| ranges_overlap(pair[0].range, pair[1].range))
        {
            return Err(unsafe_edit(UnsafeEditReason::OverlappingEdits));
        }
        documents.push(ValidatedProjectedDocumentEdits {
            expected_version: expected_versions[&uri],
            normalized_uri: uri,
            edits,
        });
    }
    Ok(ValidatedProjectedEditTransaction { documents })
}

fn unsafe_edit(reason: UnsafeEditReason) -> ProjectedEditFailure {
    ProjectedEditFailure::UnsafeEdit { reason }
}

fn ranges_overlap(left: TextRange, right: TextRange) -> bool {
    if left.is_empty() && right.is_empty() {
        left.start == right.start
    } else {
        left.start < right.end && right.start < left.end
            || left.is_empty() && right.start <= left.start && left.start < right.end
            || right.is_empty() && left.start <= right.start && right.start < left.end
    }
}

fn decode_range(
    source: &str,
    range: ProjectedEditRange,
    encoding: ProjectedEditEncoding,
) -> Result<TextRange, ProjectedEditFailure> {
    let start = decode_position(source, range.start, encoding)?;
    let end = decode_position(source, range.end, encoding)?;
    if start > end {
        return Err(unsafe_edit(UnsafeEditReason::ReversedRange));
    }
    Ok(TextRange::new(start, end))
}

fn decode_position(
    source: &str,
    position: ProjectedEditPosition,
    encoding: ProjectedEditEncoding,
) -> Result<usize, ProjectedEditFailure> {
    let line = usize::try_from(position.line)
        .map_err(|_| unsafe_edit(UnsafeEditReason::InvalidPosition))?;
    let character = usize::try_from(position.character)
        .map_err(|_| unsafe_edit(UnsafeEditReason::InvalidPosition))?;
    let line_start = if line == 0 {
        0
    } else {
        source
            .match_indices('\n')
            .nth(line - 1)
            .map(|(offset, _)| offset + 1)
            .ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidPosition))?
    };
    let raw_end = source[line_start..]
        .find('\n')
        .map_or(source.len(), |offset| line_start + offset);
    let line_end = raw_end
        .checked_sub(usize::from(
            raw_end > line_start && source.as_bytes()[raw_end - 1] == b'\r',
        ))
        .ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidPosition))?;
    let line_text = &source[line_start..line_end];
    let mut units = 0usize;
    if character == 0 {
        return Ok(line_start);
    }
    for (offset, scalar) in line_text.char_indices() {
        units += match encoding {
            ProjectedEditEncoding::Utf8 => scalar.len_utf8(),
            ProjectedEditEncoding::Utf16 => scalar.len_utf16(),
        };
        if units == character {
            return Ok(line_start + offset + scalar.len_utf8());
        }
        if units > character {
            return Err(unsafe_edit(UnsafeEditReason::InvalidPosition));
        }
    }
    Err(unsafe_edit(UnsafeEditReason::InvalidPosition))
}

/// Canonicalizes URI aliases before identity, overlap, and version checks.
/// Query and fragment components are rejected because editor document targets
/// cannot safely identify a distinct writable buffer with either component.
pub fn normalize_projected_edit_uri(uri: &str) -> Result<String, ProjectedEditFailure> {
    normalize_uri(uri)
}

fn normalize_uri(uri: &str) -> Result<String, ProjectedEditFailure> {
    if uri.contains(['?', '#', '\\']) {
        return Err(unsafe_edit(UnsafeEditReason::InvalidUri));
    }
    let colon = uri
        .find(':')
        .ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidUri))?;
    let scheme = &uri[..colon];
    if scheme.is_empty()
        || !scheme.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || index > 0 && (byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.'))
        })
    {
        return Err(unsafe_edit(UnsafeEditReason::InvalidUri));
    }
    let scheme = scheme.to_ascii_lowercase();
    let remainder = &uri[colon + 1..];
    let (authority, path) = if let Some(rest) = remainder.strip_prefix("//") {
        let split = rest.find('/').unwrap_or(rest.len());
        (&rest[..split], &rest[split..])
    } else {
        ("", remainder)
    };
    let authority = if scheme == "file" && authority.eq_ignore_ascii_case("localhost") {
        String::new()
    } else {
        authority.to_ascii_lowercase()
    };
    let path = normalize_percent_encoding(path)?;
    let absolute = path.starts_with('/');
    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(unsafe_edit(UnsafeEditReason::InvalidUri));
                }
            }
            _ => segments.push(segment),
        }
    }
    let mut path = format!("{}{}", if absolute { "/" } else { "" }, segments.join("/"));
    if scheme == "file"
        && path.len() >= 3
        && path.as_bytes()[0] == b'/'
        && path.as_bytes()[2] == b':'
    {
        path.replace_range(1..2, &path[1..2].to_ascii_lowercase());
    }
    Ok(if remainder.starts_with("//") || scheme == "file" {
        format!("{scheme}://{authority}{path}")
    } else {
        format!("{scheme}:{path}")
    })
}

fn normalize_percent_encoding(value: &str) -> Result<String, ProjectedEditFailure> {
    let bytes = value.as_bytes();
    let mut normalized = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let scalar = value[index..]
                .chars()
                .next()
                .ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidUri))?;
            normalized.push(scalar);
            index += scalar.len_utf8();
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(unsafe_edit(UnsafeEditReason::InvalidUri));
        }
        let high =
            hex(bytes[index + 1]).ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidUri))?;
        let low = hex(bytes[index + 2]).ok_or_else(|| unsafe_edit(UnsafeEditReason::InvalidUri))?;
        let byte = high * 16 + low;
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            normalized.push(char::from(byte));
        } else {
            normalized.push('%');
            normalized.push(
                char::from_digit(u32::from(high), 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
            normalized.push(
                char::from_digit(u32::from(low), 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
        }
        index += 3;
    }
    Ok(normalized)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
