use crate::ast::{Directive, Node, Statement, StatementKind};
use crate::types::{ChatLine, MmtOutput, PackConfig, Segment, YuzuTalk};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct CompileOptions {
    pub typst_mode: bool,
    pub join_with_newline: bool,
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            typst_mode: false,
            join_with_newline: true,
        }
    }
}

struct PackV2Data {
    root: PathBuf,
    aliases_to_id: HashMap<String, String>,
    id_to_avatar: HashMap<String, String>,
}

enum InlineSegment {
    Text(String),
    Expr {
        query: String,
        target: String,
        raw: String,
    },
}

pub struct CompilerState {
    pub meta: HashMap<String, String>,
    pub packs: PackConfig,
    pub chat: Vec<ChatLine>,
    pub custom_chars: Vec<(String, String, String)>,
    pub typst_global: String,

    options: CompileOptions,
    pack_v2_root: Option<PathBuf>,
    pack_v2_base_root: Option<PathBuf>,
    pack_ba: Option<PackV2Data>,

    left_speaker: Option<String>,
    right_speaker: Option<String>,

    aliases: HashMap<String, String>,
    tmp_aliases_pending: HashMap<String, String>,
    tmp_aliases_active: Option<(String, String)>,

    alias_id_to_name: HashMap<String, String>,
    custom_id_to_display: HashMap<String, String>,
    current_avatar_override_by_char_id: HashMap<String, String>,

    name_map: HashMap<String, String>,
    id_to_display: HashMap<String, String>,

    left_history: Vec<String>,
    right_history: Vec<String>,
    left_unique_first_seen: Vec<String>,
    right_unique_first_seen: Vec<String>,
}

impl Default for CompilerState {
    fn default() -> Self {
        Self {
            meta: HashMap::new(),
            packs: PackConfig::default(),
            chat: Vec::new(),
            custom_chars: Vec::new(),
            typst_global: String::new(),
            options: CompileOptions::default(),
            pack_v2_root: None,
            pack_v2_base_root: None,
            pack_ba: None,
            left_speaker: None,
            right_speaker: None,
            aliases: HashMap::new(),
            tmp_aliases_pending: HashMap::new(),
            tmp_aliases_active: None,
            alias_id_to_name: HashMap::new(),
            custom_id_to_display: HashMap::new(),
            current_avatar_override_by_char_id: HashMap::new(),
            name_map: HashMap::new(),
            id_to_display: HashMap::new(),
            left_history: Vec::new(),
            right_history: Vec::new(),
            left_unique_first_seen: Vec::new(),
            right_unique_first_seen: Vec::new(),
        }
    }
}

impl CompilerState {
    pub fn new() -> Self {
        let mut st = Self::default();
        st.init_pack_v2();
        st
    }

    pub fn new_without_pack() -> Self {
        Self::default()
    }

    pub fn new_without_pack_with_options(options: CompileOptions) -> Self {
        let mut st = Self::default();
        st.options = options;
        st
    }

    pub fn with_options(options: CompileOptions) -> Self {
        let mut st = Self::default();
        st.options = options;
        st.init_pack_v2();
        st
    }

    pub fn set_pack_v2_from_json(
        &mut self,
        pack_root: &str,
        base_root: &str,
        char_id_json: &str,
        asset_mapping_json: &str,
    ) {
        if let Some((pack, base_root)) =
            load_pack_v2_from_json(pack_root, base_root, char_id_json, asset_mapping_json)
        {
            self.pack_v2_root = Some(pack.root.clone());
            self.pack_v2_base_root = Some(base_root);
            self.pack_ba = Some(pack);
        }
    }

    fn init_pack_v2(&mut self) {
        let root = default_pack_v2_root();
        if let Some(r) = root {
            self.pack_v2_base_root = r.parent().map(|p| p.to_path_buf());
            let ba_root = r.join("ba");
            if let Some(pack) = load_pack_v2(&ba_root) {
                self.pack_v2_root = Some(r);
                self.pack_ba = Some(pack);
            }
        }
    }

    pub fn compile(mut self, nodes: Vec<Node>) -> MmtOutput {
        for node in nodes {
            match node {
                Node::Directive(d) => self.handle_directive(d),
                Node::Statement(s) => self.handle_statement(s),
                Node::Continuation(c) => self.handle_continuation(c),
                Node::BlankLine(b) => self.handle_blank_line(b),
                _ => {}
            }
        }

        self.attach_segments();
        self.custom_chars = self.build_custom_chars();

        MmtOutput {
            chars: vec![],
            chat: self.chat,
            custom_chars: self.custom_chars,
            meta: self.meta,
            packs: self.packs,
            typst_global: self.typst_global,
        }
    }

    fn handle_directive(&mut self, d: Directive) {
        let name = d.name.trim().to_lowercase();
        match name.as_str() {
            "title" => {
                self.meta.insert("title".to_string(), d.payload);
            }
            "usepack" => {
                let parts: Vec<&str> = d.payload.split_whitespace().collect();
                if parts.len() >= 3 && parts[1] == "as" {
                    let pack = parts[0].to_string();
                    let alias = parts[2].to_string();
                    self.packs.aliases.insert(alias.clone(), pack);
                    if !self.packs.order.contains(&alias) {
                        self.packs.order.push(alias);
                    }
                }
            }
            "alias" => {
                if let Some((name, val)) = d.payload.split_once('=') {
                    let char_id = self.resolve_char_id(name.trim());
                    if !val.trim().is_empty() {
                        self.aliases.insert(char_id, val.trim().to_string());
                    } else {
                        self.aliases.remove(&char_id);
                    }
                }
            }
            "tmpalias" => {
                if let Some((name, val)) = d.payload.split_once('=') {
                    let char_id = self.resolve_char_id(name.trim());
                    self.tmp_aliases_pending
                        .insert(char_id, val.trim().to_string());
                }
            }
            "aliasid" => {
                let parts: Vec<&str> = d.payload.split_whitespace().collect();
                if parts.len() >= 2 {
                    let alias_id = parts[0].to_string();
                    let name_val = parts[1..].join(" ");
                    if !alias_id.trim().is_empty() && !name_val.trim().is_empty() {
                        self.alias_id_to_name.insert(alias_id, name_val);
                    }
                }
            }
            "unaliasid" => {
                let alias_id = d.payload.trim();
                if !alias_id.is_empty() {
                    self.alias_id_to_name.remove(alias_id);
                }
            }
            "charid" => {
                let parts: Vec<&str> = d.payload.split_whitespace().collect();
                if parts.len() >= 2 {
                    let cid = parts[0].to_string();
                    let display = parts[1..].join(" ");
                    if !cid.trim().is_empty() && !display.trim().is_empty() {
                        self.custom_id_to_display.insert(cid, display);
                    }
                }
            }
            "uncharid" => {
                let cid = d.payload.trim();
                if !cid.is_empty() {
                    self.custom_id_to_display.remove(cid);
                }
            }
            "avatar" => {
                if let Some((name, asset)) = d.payload.split_once('=') {
                    let char_id = self.resolve_char_id(name.trim());
                    let mut asset_name = asset.trim().to_string();
                    if asset_name.is_empty() {
                        self.current_avatar_override_by_char_id.remove(&char_id);
                    } else {
                        if !asset_name.to_lowercase().starts_with("asset:") {
                            asset_name = format!("asset:{}", asset_name);
                        }
                        self.current_avatar_override_by_char_id
                            .insert(char_id, asset_name);
                    }
                }
            }
            "pagebreak" => {
                self.chat.push(ChatLine {
                    char_id: None,
                    content: String::new(),
                    line_no: d.line_no,
                    segments: vec![],
                    side: None,
                    avatar_override: None,
                    yuzutalk: YuzuTalk {
                        avatar_state: "AUTO".to_string(),
                        name_override: String::new(),
                        r#type: "PAGEBREAK".to_string(),
                    },
                });
            }
            _ => {
                if name.starts_with("asset.") {
                    self.meta.insert(name, d.payload);
                }
            }
        }
    }

    fn handle_statement(&mut self, s: Statement) {
        if let StatementKind::Narration = s.kind {
            self.chat.push(ChatLine {
                char_id: None,
                content: s.content.clone(),
                line_no: s.line_no,
                segments: vec![],
                side: None,
                avatar_override: None,
                yuzutalk: YuzuTalk {
                    avatar_state: "AUTO".to_string(),
                    name_override: String::new(),
                    r#type: "NARRATION".to_string(),
                },
            });
            return;
        }

        let side = match s.kind {
            StatementKind::Left => "left",
            StatementKind::Right => "right",
            _ => "left",
        };

        let (speaker_id, explicit_display) = self.resolve_speaker(&s, side);

        if side == "left" {
            self.left_speaker = Some(speaker_id.clone());
        } else {
            self.right_speaker = Some(speaker_id.clone());
        }
        self.update_history(side, speaker_id.clone());

        if let Some(display) = explicit_display {
            self.id_to_display.insert(speaker_id.clone(), display);
        }

        if let Some((active_id, _)) = &self.tmp_aliases_active {
            if *active_id != speaker_id {
                self.tmp_aliases_active = None;
            }
        }

        if let Some(val) = self.tmp_aliases_pending.remove(&speaker_id) {
            self.tmp_aliases_active = Some((speaker_id.clone(), val));
        }

        let mut name_override = String::new();
        if let Some((active_id, val)) = &self.tmp_aliases_active {
            if *active_id == speaker_id {
                name_override = val.clone();
            }
        } else if let Some(val) = self.aliases.get(&speaker_id) {
            name_override = val.clone();
        }

        let avatar_override = self
            .current_avatar_override_by_char_id
            .get(&speaker_id)
            .cloned();
        let line = ChatLine {
            char_id: Some(speaker_id),
            content: s.content,
            line_no: s.line_no,
            segments: vec![],
            side: Some(side.to_string()),
            avatar_override,
            yuzutalk: YuzuTalk {
                avatar_state: "AUTO".to_string(),
                name_override: name_override,
                r#type: "TEXT".to_string(),
            },
        };

        self.chat.push(line);
    }

    fn handle_continuation(&mut self, c: crate::ast::Continuation) {
        if self.chat.is_empty() {
            return;
        }
        let sep = if self.options.join_with_newline {
            "\n"
        } else {
            " "
        };
        let last = self.chat.last_mut().unwrap();
        last.content = format!("{}{}{}", last.content, sep, c.text);
    }

    fn handle_blank_line(&mut self, _b: crate::ast::BlankLine) {
        if !self.options.typst_mode {
            return;
        }
        if self.chat.is_empty() {
            return;
        }
        let sep = if self.options.join_with_newline {
            "\n"
        } else {
            " "
        };
        let last = self.chat.last_mut().unwrap();
        last.content = format!("{}{}", last.content, sep);
    }

    fn update_history(&mut self, side: &str, speaker_id: String) {
        let history = if side == "left" {
            &mut self.left_history
        } else {
            &mut self.right_history
        };
        if history.is_empty() || history.last() != Some(&speaker_id) {
            history.push(speaker_id.clone());
        }

        let unique_first_seen = if side == "left" {
            &mut self.left_unique_first_seen
        } else {
            &mut self.right_unique_first_seen
        };
        if !unique_first_seen.contains(&speaker_id) {
            unique_first_seen.push(speaker_id);
        }
    }

    fn display_for_id(&self, id: &str) -> Option<String> {
        if let Some(raw) = id.strip_prefix("custom-") {
            if let Some(display) = self.custom_id_to_display.get(raw) {
                return Some(display.clone());
            }
            return Some(raw.to_string());
        }
        if let Some(raw) = id.strip_prefix("ba.") {
            return Some(base_name(raw));
        }
        if id == "__Sensei" {
            return Some("Sensei".to_string());
        }
        Some(id.to_string())
    }

    fn resolve_speaker(&mut self, s: &Statement, side: &str) -> (String, Option<String>) {
        let (history, unique_first_seen) = if side == "left" {
            (&self.left_history, &self.left_unique_first_seen)
        } else {
            (&self.right_history, &self.right_unique_first_seen)
        };

        if let Some(sp) = &s.speaker {
            if let Some(rest) = sp.strip_prefix('_') {
                let n = if rest.is_empty() {
                    1
                } else {
                    rest.parse::<usize>().unwrap_or(1)
                };
                if n > 0 && history.len() >= n + 1 {
                    let id = history[history.len() - (n + 1)].clone();
                    return (id, None);
                }
                if let Some(last) = history.last() {
                    return (last.clone(), None);
                }
            }
            if let Some(rest) = sp.strip_prefix('~') {
                let n = if rest.is_empty() {
                    1
                } else {
                    rest.parse::<usize>().unwrap_or(1)
                };
                if n > 0 && unique_first_seen.len() >= n {
                    let id = unique_first_seen[n - 1].clone();
                    return (id, None);
                }
            }

            let id = self.resolve_char_id(sp);
            let display = self.display_for_id(&id);
            return (id, display);
        } else {
            let current = match s.kind {
                StatementKind::Left => &self.left_speaker,
                StatementKind::Right => &self.right_speaker,
                _ => &None,
            };
            if let Some(id) = current {
                return (id.clone(), None);
            }
            return ("__Sensei".to_string(), Some("Sensei".to_string()));
        }
    }

    fn resolve_char_id(&self, name: &str) -> String {
        let mut token = name.trim();
        if let Some(alias) = self.alias_id_to_name.get(token) {
            token = alias;
        }
        if token.starts_with("ba.") {
            return token.to_string();
        }
        if token.starts_with("custom-") {
            return token.to_string();
        }
        if self.custom_id_to_display.contains_key(token) {
            return format!("custom-{}", token);
        }
        if let Some(pack) = &self.pack_ba {
            if let Some(id) = pack.aliases_to_id.get(token) {
                return format!("ba.{}", id);
            }
        }
        format!("ba.{}", token)
    }

    fn attach_segments(&mut self) {
        let mut current_char: Option<String> = None;
        for msg in &mut self.chat {
            let msg_type = msg.yuzutalk.r#type.as_str();
            if msg_type == "PAGEBREAK" {
                continue;
            }
            if msg_type == "TEXT" {
                current_char = msg.char_id.clone();
            }
            let segments = build_segments(
                &msg.content,
                current_char.as_deref(),
                self.options.typst_mode,
            );
            if !segments.is_empty() {
                msg.segments = segments;
            }
        }
    }

    fn build_custom_chars(&self) -> Vec<(String, String, String)> {
        let mut out: Vec<(String, String, String)> = Vec::new();
        let mut seen: HashMap<String, bool> = HashMap::new();
        for msg in &self.chat {
            let Some(char_id) = msg.char_id.as_ref() else {
                continue;
            };
            if char_id == "__Sensei" {
                continue;
            }
            if seen.get(char_id).is_some() {
                continue;
            }
            seen.insert(char_id.clone(), true);

            if let Some(cid) = char_id.strip_prefix("custom-") {
                let display = self
                    .custom_id_to_display
                    .get(cid)
                    .cloned()
                    .unwrap_or_else(|| cid.to_string());
                out.push((char_id.clone(), "uploaded".to_string(), display));
                continue;
            }

            if let Some(pack) = &self.pack_ba {
                if let Some(cid) = char_id.strip_prefix("ba.") {
                    if let Some(avatar_rel) = pack.id_to_avatar.get(cid) {
                        if let Some(base_root) = &self.pack_v2_base_root {
                            if let Ok(rel_pack) = pack.root.strip_prefix(base_root) {
                                let avatar_ref =
                                    format!("/{}/{}", rel_pack.to_string_lossy(), avatar_rel);
                                let display_name = base_name(
                                    self.id_to_display
                                        .get(char_id)
                                        .map(|s| s.as_str())
                                        .unwrap_or(cid),
                                );
                                out.push((char_id.clone(), avatar_ref, display_name));
                                continue;
                            }
                        }
                    }
                }
            }
            let display_name = base_name(
                self.id_to_display
                    .get(char_id)
                    .map(|s| s.as_str())
                    .unwrap_or(char_id),
            );
            out.push((char_id.clone(), "uploaded".to_string(), display_name));
        }
        out
    }
}

fn default_pack_v2_root() -> Option<PathBuf> {
    let candidates = [
        "pack-v2",
        "typst_sandbox/pack-v2",
        "../pack-v2",
        "../typst_sandbox/pack-v2",
    ];
    for cand in candidates {
        let path = Path::new(cand);
        if path.exists() {
            return Some(path.to_path_buf());
        }
    }
    None
}

fn load_pack_v2(pack_root: &Path) -> Option<PackV2Data> {
    if !pack_root.exists() {
        return None;
    }
    let mapping_path = pack_root.join("asset_mapping.json");
    if !mapping_path.exists() {
        return None;
    }

    let mut aliases_to_id: HashMap<String, String> = HashMap::new();
    let char_id_path = pack_root.join("char_id.json");
    if char_id_path.exists() {
        if let Ok(text) = fs::read_to_string(char_id_path) {
            aliases_to_id = parse_char_id_json(&text);
        }
    }

    let mut id_to_avatar: HashMap<String, String> = HashMap::new();
    if let Ok(text) = fs::read_to_string(mapping_path) {
        id_to_avatar = parse_asset_mapping_json(&text);
    }

    if id_to_avatar.is_empty() {
        return None;
    }

    for id in id_to_avatar.keys() {
        aliases_to_id
            .entry(id.clone())
            .or_insert_with(|| id.clone());
    }

    Some(PackV2Data {
        root: pack_root.to_path_buf(),
        aliases_to_id,
        id_to_avatar,
    })
}

fn load_pack_v2_from_json(
    pack_root: &str,
    base_root: &str,
    char_id_json: &str,
    asset_mapping_json: &str,
) -> Option<(PackV2Data, PathBuf)> {
    let mut aliases_to_id = parse_char_id_json(char_id_json);
    let id_to_avatar = parse_asset_mapping_json(asset_mapping_json);

    if id_to_avatar.is_empty() {
        return None;
    }

    for id in id_to_avatar.keys() {
        aliases_to_id
            .entry(id.clone())
            .or_insert_with(|| id.clone());
    }

    Some((
        PackV2Data {
            root: PathBuf::from(pack_root),
            aliases_to_id,
            id_to_avatar,
        },
        PathBuf::from(base_root),
    ))
}

fn parse_char_id_json(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(obj) = value.as_object() {
            for (k, v) in obj {
                if let Some(id) = v.as_str() {
                    if !k.trim().is_empty() && !id.trim().is_empty() {
                        out.insert(k.trim().to_string(), id.trim().to_string());
                    }
                }
            }
        }
    }
    out
}

fn parse_asset_mapping_json(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(obj) = value.as_object() {
            for (k, v) in obj {
                if let Some(map) = v.as_object() {
                    if let Some(avatar) = map.get("avatar").and_then(|v| v.as_str()) {
                        if !avatar.trim().is_empty() {
                            out.insert(k.to_string(), avatar.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

fn base_name(name: &str) -> String {
    let mut out = name.trim();
    if let Some(idx) = out.find('(') {
        out = &out[..idx];
    } else if let Some(idx) = out.find('（') {
        out = &out[..idx];
    }
    out.trim().to_string()
}

fn build_segments(content: &str, current_char: Option<&str>, typst_mode: bool) -> Vec<Segment> {
    let segments = parse_inline_segments(content, typst_mode, typst_mode);
    if segments.is_empty() {
        return vec![Segment::Text {
            text: content.to_string(),
        }];
    }

    let mut out: Vec<Segment> = Vec::new();
    for seg in segments {
        match seg {
            InlineSegment::Text(text) => {
                if !text.is_empty() {
                    out.push(Segment::Text { text });
                }
            }
            InlineSegment::Expr { query, target, raw } => {
                let mut q = query.trim().to_string();
                if q.starts_with(':') {
                    q = q[1..].trim_start().to_string();
                }
                if typst_mode && !query.trim().starts_with(':') {
                    out.push(Segment::Text { text: raw });
                    continue;
                }
                if q.is_empty() {
                    out.push(Segment::Text { text: raw });
                    continue;
                }
                let target_id = if target.trim().is_empty() {
                    if let Some(cid) = current_char {
                        cid.to_string()
                    } else {
                        out.push(Segment::Text { text: raw });
                        continue;
                    }
                } else {
                    if let Some(cid) = current_char {
                        let _ = cid;
                    }
                    if target.starts_with("ba.") {
                        target.to_string()
                    } else {
                        format!("ba.{}", target)
                    }
                };
                let text = format!("[{}]", q);
                out.push(Segment::Expr {
                    text,
                    query: q,
                    target_char_id: target_id,
                });
            }
        }
    }

    if out.is_empty() {
        vec![Segment::Text {
            text: content.to_string(),
        }]
    } else {
        out
    }
}

fn parse_inline_segments(
    content: &str,
    require_colon_prefix: bool,
    preserve_backslash: bool,
) -> Vec<InlineSegment> {
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    let len = chars.len();
    let mut buf = String::new();
    let mut out: Vec<InlineSegment> = Vec::new();

    let mut flush_text = |buf: &mut String, out: &mut Vec<InlineSegment>| {
        if !buf.is_empty() {
            out.push(InlineSegment::Text(buf.clone()));
            buf.clear();
        }
    };

    while i < len {
        let ch = chars[i];
        if ch == '\\' && i + 1 < len {
            if preserve_backslash {
                buf.push('\\');
            }
            buf.push(chars[i + 1]);
            i += 2;
            continue;
        }

        if ch == '(' {
            if let Some((target, close_idx)) =
                parse_delimited(&chars, i + 1, ')', preserve_backslash)
            {
                if close_idx + 1 < len && chars[close_idx + 1] == '[' {
                    if let Some((query, end_idx)) =
                        parse_delimited(&chars, close_idx + 2, ']', preserve_backslash)
                    {
                        let raw = slice_chars(&chars, i, end_idx + 1);
                        if require_colon_prefix && !query.trim().starts_with(':') {
                            buf.push_str(&raw);
                            i = end_idx + 1;
                            continue;
                        }
                        flush_text(&mut buf, &mut out);
                        out.push(InlineSegment::Expr { query, target, raw });
                        i = end_idx + 1;
                        continue;
                    }
                }
            }
        }

        if ch == '[' {
            if let Some((query, close_idx)) =
                parse_delimited(&chars, i + 1, ']', preserve_backslash)
            {
                let mut target = String::new();
                let mut end_idx = close_idx + 1;
                if end_idx < len && chars[end_idx] == '(' {
                    if let Some((t, t_end)) =
                        parse_delimited(&chars, end_idx + 1, ')', preserve_backslash)
                    {
                        target = t;
                        end_idx = t_end + 1;
                    }
                }
                let raw = slice_chars(&chars, i, end_idx);
                if require_colon_prefix && !query.trim().starts_with(':') {
                    buf.push_str(&raw);
                    i = end_idx;
                    continue;
                }
                flush_text(&mut buf, &mut out);
                out.push(InlineSegment::Expr { query, target, raw });
                i = end_idx;
                continue;
            }
        }

        buf.push(ch);
        i += 1;
    }

    if !buf.is_empty() {
        out.push(InlineSegment::Text(buf));
    }

    out
}

fn parse_delimited(
    chars: &[char],
    mut idx: usize,
    close: char,
    preserve_backslash: bool,
) -> Option<(String, usize)> {
    let mut out = String::new();
    while idx < chars.len() {
        let c = chars[idx];
        if c == '\\' && idx + 1 < chars.len() {
            if preserve_backslash {
                out.push('\\');
            }
            out.push(chars[idx + 1]);
            idx += 2;
            continue;
        }
        if c == close {
            return Some((out, idx));
        }
        out.push(c);
        idx += 1;
    }
    None
}

fn slice_chars(chars: &[char], start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut i = start;
    let end_idx = end.min(chars.len());
    while i < end_idx {
        out.push(chars[i]);
        i += 1;
    }
    out
}
