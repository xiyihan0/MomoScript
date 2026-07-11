use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::{
    EmitOptions, ProjectMaterializer, ProjectMaterializerOptions, SourceSpan, compile_text_strict,
    export_template_library,
};
use serde::Serialize;

#[derive(Debug)]
struct Options {
    input: Option<PathBuf>,
    output_dir: PathBuf,
    manifests: Vec<PathBuf>,
    template_dir: PathBuf,
    workspace_root: PathBuf,
    title: String,
    author: Option<String>,
    cache_dir: PathBuf,
    avifdec_bin: PathBuf,
    decoder_profile: String,
}

#[derive(Serialize)]
struct CliReport {
    success: bool,
    output_dir: Option<String>,
    diagnostics: Vec<CliDiagnostic>,
}

#[derive(Serialize)]
struct CliDiagnostic {
    phase: String,
    severity: String,
    message: String,
    span: Option<SourceSpan>,
}

#[derive(Serialize)]
struct SourceMapReport<'a> {
    schema: &'static str,
    generated_file: &'static str,
    source_file: &'static str,
    origins: &'a [mmt_rs::emit::Origin],
    source_map: &'a [mmt_rs::emit::SourceMapEntry],
}

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(report) => {
            println!("{}", serde_json::to_string(&report).unwrap());
            ExitCode::SUCCESS
        }
        Err(report) => {
            println!("{}", serde_json::to_string(&report).unwrap());
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<OsString>) -> Result<CliReport, CliReport> {
    let options = parse_args(args).map_err(host_error)?;
    let source = read_source(options.input.as_deref()).map_err(host_error)?;
    let (registry, pack_roots) = load_registry(&options.manifests).map_err(host_error)?;
    let mut materializer = ProjectMaterializer::new(ProjectMaterializerOptions {
        output_dir: options.output_dir.clone(),
        workspace_root: options.workspace_root,
        pack_roots,
        cache_dir: options.cache_dir,
        avifdec_bin: options.avifdec_bin,
        decoder_profile: options.decoder_profile,
    })
    .map_err(|error| host_error(error.message))?;
    let emit_options = EmitOptions {
        template_import: "template/lib.typ".to_string(),
        title: options.title,
        author: options.author,
        ..EmitOptions::default()
    };

    match compile_text_strict(&source, &registry, &mut materializer, &emit_options) {
        Ok(compilation) => {
            export_template_library(&options.template_dir, &options.output_dir)
                .map_err(|error| host_error(error.message))?;
            fs::write(
                options.output_dir.join("main.typ"),
                &compilation.typst.source,
            )
            .map_err(|error| host_error(format!("cannot write main.typ: {error}")))?;
            fs::write(options.output_dir.join("source.mmt"), &source)
                .map_err(|error| host_error(format!("cannot write source.mmt: {error}")))?;
            let source_map = serde_json::to_vec_pretty(&SourceMapReport {
                schema: "mmt.source-map.v1",
                generated_file: "main.typ",
                source_file: "source.mmt",
                origins: &compilation.typst.origins,
                source_map: &compilation.typst.source_map,
            })
            .map_err(|error| host_error(format!("cannot serialize source map: {error}")))?;
            fs::write(options.output_dir.join("source-map.json"), source_map)
                .map_err(|error| host_error(format!("cannot write source-map.json: {error}")))?;
            Ok(CliReport {
                success: true,
                output_dir: Some(options.output_dir.display().to_string()),
                diagnostics: diagnostics(&source, &compilation.diagnostics),
            })
        }
        Err(failure) => Err(CliReport {
            success: false,
            output_dir: None,
            diagnostics: diagnostics(&source, &failure.diagnostics),
        }),
    }
}

fn parse_args(args: Vec<OsString>) -> Result<Options, String> {
    let mut input = None;
    let mut output_dir = None;
    let mut manifests = Vec::new();
    let mut template_dir = PathBuf::from("typst_sandbox/mmt_render");
    let mut workspace_root = env::current_dir().map_err(|error| error.to_string())?;
    let mut title = "无题".to_string();
    let mut author = None;
    let mut cache_dir = PathBuf::from(".cache/mmt-rs/materialized");
    let mut avifdec_bin = PathBuf::from("avifdec");
    let mut decoder_profile = "avifdec-dav1d-png-v1".to_string();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg
            .into_string()
            .map_err(|_| "arguments must be valid UTF-8".to_string())?;
        let value = |args: &mut std::vec::IntoIter<OsString>, name: &str| {
            args.next()
                .ok_or_else(|| format!("{name} requires a value"))
                .and_then(|value| {
                    value
                        .into_string()
                        .map_err(|_| format!("{name} value must be valid UTF-8"))
                })
        };
        match arg.as_str() {
            "--input" => input = Some(PathBuf::from(value(&mut args, "--input")?)),
            "--output-dir" => output_dir = Some(PathBuf::from(value(&mut args, "--output-dir")?)),
            "--manifest" => manifests.push(PathBuf::from(value(&mut args, "--manifest")?)),
            "--template-dir" => template_dir = PathBuf::from(value(&mut args, "--template-dir")?),
            "--workspace-root" => {
                workspace_root = PathBuf::from(value(&mut args, "--workspace-root")?)
            }
            "--title" => title = value(&mut args, "--title")?,
            "--author" => author = Some(value(&mut args, "--author")?),
            "--cache-dir" => cache_dir = PathBuf::from(value(&mut args, "--cache-dir")?),
            "--avifdec-bin" => avifdec_bin = PathBuf::from(value(&mut args, "--avifdec-bin")?),
            "--decoder-profile" => decoder_profile = value(&mut args, "--decoder-profile")?,
            "--help" | "-h" => return Err(usage()),
            _ => return Err(format!("unknown argument '{arg}'\n{}", usage())),
        }
    }
    Ok(Options {
        input,
        output_dir: output_dir.ok_or_else(usage)?,
        manifests,
        template_dir,
        workspace_root,
        title,
        author,
        cache_dir,
        avifdec_bin,
        decoder_profile,
    })
}

fn usage() -> String {
    "usage: mmt-compile [--input FILE] --output-dir DIR [--manifest FILE ...] [--template-dir DIR] [--workspace-root DIR] [--cache-dir DIR] [--avifdec-bin FILE] [--decoder-profile ID] [--title TEXT] [--author TEXT]".to_string()
}

fn read_source(path: Option<&Path>) -> Result<String, String> {
    match path {
        Some(path) if path != Path::new("-") => fs::read_to_string(path)
            .map_err(|error| format!("cannot read '{}': {error}", path.display())),
        _ => {
            let mut source = String::new();
            io::stdin()
                .read_to_string(&mut source)
                .map_err(|error| format!("cannot read stdin: {error}"))?;
            Ok(source)
        }
    }
}

fn load_registry(paths: &[PathBuf]) -> Result<(PackRegistry, HashMap<String, PathBuf>), String> {
    let mut manifests = Vec::new();
    let mut roots = HashMap::new();
    for path in paths {
        let source = fs::read_to_string(path)
            .map_err(|error| format!("cannot read manifest '{}': {error}", path.display()))?;
        let manifest = PackManifest::from_json(&source)
            .map_err(|error| format!("invalid manifest '{}': {error}", path.display()))?;
        let root = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        roots.insert(manifest.pack.namespace.clone(), root);
        manifests.push(manifest);
    }
    let registry = PackRegistry::new(manifests).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; ")
    })?;
    Ok((registry, roots))
}

fn diagnostics(source: &str, items: &[mmt_rs::diag::Diagnostic]) -> Vec<CliDiagnostic> {
    let source_file = mmt_rs::source::SourceFile::anonymous(source);
    items
        .iter()
        .map(|diagnostic| CliDiagnostic {
            phase: format!("{:?}", diagnostic.phase).to_lowercase(),
            severity: format!("{:?}", diagnostic.severity).to_lowercase(),
            message: diagnostic.message.clone(),
            span: diagnostic.range.and_then(|range| {
                let start = source_file.line_column(range.start)?;
                let end = source_file.line_column(range.end)?;
                Some(SourceSpan { range, start, end })
            }),
        })
        .collect()
}

fn host_error(message: impl Into<String>) -> CliReport {
    CliReport {
        success: false,
        output_dir: None,
        diagnostics: vec![CliDiagnostic {
            phase: "host".to_string(),
            severity: "error".to_string(),
            message: message.into(),
            span: None,
        }],
    }
}
