use std::fs;
use std::path::{Path, PathBuf};

use mmt_rs::diag::{Diagnostic, DiagnosticPhase, Severity};
use mmt_rs::emit::EmittedTypst;
use mmt_rs::source::TextRange;
use typst::World;
use typst::diag::{FileError, FileResult, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, WorldExt};
use typst_kit::files::{FileLoader, FileStore, FsRoot};
use typst_kit::fonts::{self, FontStore};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

pub fn compile_pdf(
    project_root: &Path,
    output: &Path,
    emitted: &EmittedTypst,
) -> Result<Vec<Diagnostic>, Vec<Diagnostic>> {
    let world = ProjectWorld::new(project_root).map_err(|message| {
        vec![Diagnostic::new(
            Severity::Error,
            DiagnosticPhase::Typst,
            message,
            None,
        )]
    })?;
    let Warned {
        output: document,
        warnings,
    } = typst::compile::<PagedDocument>(&world);
    let mut diagnostics = warnings
        .iter()
        .map(|diagnostic| map_diagnostic(&world, emitted, diagnostic))
        .collect::<Vec<_>>();
    let document = match document {
        Ok(document) => document,
        Err(errors) => {
            diagnostics.extend(
                errors
                    .iter()
                    .map(|diagnostic| map_diagnostic(&world, emitted, diagnostic)),
            );
            return Err(diagnostics);
        }
    };
    let pdf = match typst_pdf::pdf(&document, &PdfOptions::default()) {
        Ok(pdf) => pdf,
        Err(errors) => {
            diagnostics.extend(
                errors
                    .iter()
                    .map(|diagnostic| map_diagnostic(&world, emitted, diagnostic)),
            );
            return Err(diagnostics);
        }
    };
    if let Err(message) = write_atomic(output, &pdf) {
        diagnostics.push(Diagnostic::new(
            Severity::Error,
            DiagnosticPhase::Typst,
            message,
            None,
        ));
        return Err(diagnostics);
    }
    Ok(diagnostics)
}

struct ProjectWorld {
    library: LazyHash<Library>,
    fonts: FontStore,
    files: FileStore<ProjectFiles>,
}

impl ProjectWorld {
    fn new(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|error| {
            format!(
                "cannot resolve Typst project root '{}': {error}",
                root.display()
            )
        })?;
        let main_path = root.join("main.typ");
        if !main_path.is_file() {
            return Err(format!(
                "Typst project entry '{}' does not exist",
                main_path.display()
            ));
        }
        let virtual_main = VirtualPath::virtualize(&root, &main_path).map_err(|error| {
            format!(
                "cannot virtualize Typst entry '{}': {error}",
                main_path.display()
            )
        })?;
        let main = RootedPath::new(VirtualRoot::Project, virtual_main).intern();
        let mut font_store = FontStore::new();
        font_store.extend(fonts::system());
        Ok(Self {
            library: LazyHash::new(Library::default()),
            fonts: font_store,
            files: FileStore::new(ProjectFiles {
                main,
                project: FsRoot::new(root),
            }),
        })
    }
}

impl World for ProjectWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.files.loader().main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

struct ProjectFiles {
    main: FileId,
    project: FsRoot,
}

impl FileLoader for ProjectFiles {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        match id.root() {
            VirtualRoot::Project => self.project.load(id.vpath()),
            VirtualRoot::Package(_) => Err(FileError::Other(Some(
                "Typst package imports are disabled in the self-contained MMT world".into(),
            ))),
        }
    }
}

fn map_diagnostic(
    world: &ProjectWorld,
    emitted: &EmittedTypst,
    diagnostic: &SourceDiagnostic,
) -> Diagnostic {
    let mut message = diagnostic.message.to_string();
    for hint in &diagnostic.hints {
        message.push_str("; hint: ");
        message.push_str(&hint.v);
    }
    let generated_range = (diagnostic.span.id() == Some(world.main()))
        .then(|| world.range(diagnostic.span))
        .flatten()
        .map(|range| TextRange::new(range.start, range.end));
    let mut mapped = if let Some(range) = generated_range {
        emitted.map_typst_diagnostic(message, range)
    } else {
        let file = diagnostic
            .span
            .id()
            .map(|id| id.vpath().get_without_slash().to_string());
        if let Some(file) = file {
            message = format!("{file}: {message}");
        }
        Diagnostic::new(Severity::Error, DiagnosticPhase::Typst, message, None)
    };
    mapped.severity = match diagnostic.severity {
        typst::diag::Severity::Error => Severity::Error,
        typst::diag::Severity::Warning => Severity::Warning,
    };
    mapped
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "cannot create PDF directory '{}': {error}",
            parent.display()
        )
    })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output.pdf");
    let temporary: PathBuf = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("cannot write PDF '{}': {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("cannot commit PDF '{}': {error}", path.display())
    })
}
