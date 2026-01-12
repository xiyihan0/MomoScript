use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MmtOutput {
    #[serde(default)]
    pub chars: Vec<String>, 
    pub chat: Vec<ChatLine>,
    pub custom_chars: Vec<(String, String, String)>, 
    pub meta: HashMap<String, String>,
    pub packs: PackConfig,
    pub typst_global: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_id: Option<String>,
    pub content: String,
    pub line_no: usize,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub segments: Vec<Segment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_override: Option<String>,
    pub yuzutalk: YuzuTalk,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")] 
pub enum Segment {
    Text { text: String },
    Expr { text: String, query: String, target_char_id: String },
    Image { #[serde(rename = "ref")] ref_: String, alt: String }, 
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YuzuTalk {
    #[serde(rename = "avatarState")]
    pub avatar_state: String, 
    #[serde(rename = "nameOverride")]
    pub name_override: String,
    pub r#type: String, 
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PackConfig {
    #[serde(default)]
    pub aliases: HashMap<String, String>,
    #[serde(default)]
    pub order: Vec<String>,
}

impl Segment {
    pub fn text(t: impl Into<String>) -> Self {
        Segment::Text { text: t.into() }
    }
}
