use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use mmt_rs::pack::{PackManifest, PackRegistry};

fn main() -> ExitCode {
    match run(env::args_os().skip(1).map(PathBuf::from).collect()) {
        Ok(summary) => {
            println!(
                "valid pack-v3 registry: {} pack(s), {} entities, {} contributions, {} storage entries",
                summary.packs, summary.entities, summary.contributions, summary.storage_entries
            );
            ExitCode::SUCCESS
        }
        Err(errors) => {
            for error in errors {
                eprintln!("error: {error}");
            }
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RegistrySummary {
    packs: usize,
    entities: usize,
    contributions: usize,
    storage_entries: usize,
}

fn run(paths: Vec<PathBuf>) -> Result<RegistrySummary, Vec<String>> {
    if paths.is_empty() {
        return Err(vec![
            "usage: mmt-pack-validate <manifest.json> [manifest.json ...]".to_string(),
        ]);
    }

    let mut manifests = Vec::with_capacity(paths.len());
    let mut errors = Vec::new();
    for path in paths {
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                errors.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        match PackManifest::from_json(&source) {
            Ok(manifest) => manifests.push(manifest),
            Err(error) => errors.push(format!("{}: invalid JSON: {error}", path.display())),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let registry = PackRegistry::new(manifests).map_err(|validation_errors| {
        validation_errors
            .into_iter()
            .map(|error| match error.pack_namespace {
                Some(namespace) => format!("pack '{namespace}': {}", error.message),
                None => error.message,
            })
            .collect::<Vec<_>>()
    })?;
    Ok(RegistrySummary {
        packs: registry.manifests().len(),
        entities: registry
            .manifests()
            .iter()
            .map(|manifest| manifest.entities.len())
            .sum(),
        contributions: registry
            .manifests()
            .iter()
            .map(|manifest| manifest.contributions.len())
            .sum(),
        storage_entries: registry
            .manifests()
            .iter()
            .map(|manifest| manifest.storage.len())
            .sum(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_at_least_one_manifest() {
        assert!(run(Vec::new()).unwrap_err()[0].contains("usage:"));
    }
}
