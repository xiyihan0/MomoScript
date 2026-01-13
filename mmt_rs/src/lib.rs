#[cfg(not(target_arch = "wasm32"))]
use pyo3::prelude::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

mod ast;
mod compiler;
mod parser;
mod types;

#[cfg(not(target_arch = "wasm32"))]
#[pyfunction]
fn compile_text(text: String) -> PyResult<String> {
    let nodes = parser::parse(&text);
    let compiler = compiler::CompilerState::new();
    let output = compiler.compile(nodes);

    serde_json::to_string_pretty(&output)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn compile_text_wasm(text: &str) -> Result<String, JsValue> {
    let nodes = parser::parse(text);
    let compiler = compiler::CompilerState::new_without_pack();
    let output = compiler.compile(nodes);

    serde_json::to_string_pretty(&output).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn compile_text_with_options_wasm(
    text: &str,
    typst_mode: bool,
    join_with_newline: bool,
) -> Result<String, JsValue> {
    let nodes = parser::parse(text);
    let compiler =
        compiler::CompilerState::new_without_pack_with_options(compiler::CompileOptions {
            typst_mode,
            join_with_newline,
        });
    let output = compiler.compile(nodes);

    serde_json::to_string_pretty(&output).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn compile_text_with_pack_wasm(
    text: &str,
    pack_root: &str,
    base_root: &str,
    char_id_json: &str,
    asset_mapping_json: &str,
) -> Result<String, JsValue> {
    let nodes = parser::parse(text);
    let mut compiler = compiler::CompilerState::new_without_pack();
    compiler.set_pack_v2_from_json(pack_root, base_root, char_id_json, asset_mapping_json);
    let output = compiler.compile(nodes);

    serde_json::to_string_pretty(&output).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn compile_text_with_pack_and_options_wasm(
    text: &str,
    typst_mode: bool,
    join_with_newline: bool,
    pack_root: &str,
    base_root: &str,
    char_id_json: &str,
    asset_mapping_json: &str,
) -> Result<String, JsValue> {
    let nodes = parser::parse(text);
    let mut compiler =
        compiler::CompilerState::new_without_pack_with_options(compiler::CompileOptions {
            typst_mode,
            join_with_newline,
        });
    compiler.set_pack_v2_from_json(pack_root, base_root, char_id_json, asset_mapping_json);
    let output = compiler.compile(nodes);

    serde_json::to_string_pretty(&output).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(not(target_arch = "wasm32"))]
#[pymodule]
fn mmt_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(compile_text, m)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn run_fixture(input_path: &str, typst_mode: bool) {
        let golden_path = format!("{}.golden.json", input_path);
        let input = fs::read_to_string(input_path).expect("Failed to read input");
        let golden = fs::read_to_string(golden_path).expect("Failed to read golden");

        let nodes = parser::parse(&input);
        let compiler = compiler::CompilerState::with_options(compiler::CompileOptions {
            typst_mode,
            join_with_newline: true,
        });
        let output = compiler.compile(nodes);

        let json_out = serde_json::to_string_pretty(&output).unwrap();
        let v_out: serde_json::Value = serde_json::from_str(&json_out).unwrap();
        let v_golden: serde_json::Value = serde_json::from_str(&golden).unwrap();

        if v_out != v_golden {
            let chat_out = v_out["chat"].as_array().unwrap();
            let chat_golden = v_golden["chat"].as_array().unwrap();

            if chat_out.len() == chat_golden.len() {
                for (i, (a, b)) in chat_out.iter().zip(chat_golden.iter()).enumerate() {
                    if a != b {
                        println!("Mismatch at chat index {}", i);
                        println!("Got: {}", serde_json::to_string_pretty(a).unwrap());
                        println!("Exp: {}", serde_json::to_string_pretty(b).unwrap());
                        break;
                    }
                }
            }

            assert_eq!(v_out, v_golden, "Mismatch in fixture {}", input_path);
        }
    }

    #[test]
    fn test_fixtures() {
        let fixtures_path = Path::new("../mmt_core/dsl_fixtures/fixtures.json");
        let fixtures_text =
            fs::read_to_string(fixtures_path).expect("Failed to read fixtures.json");
        let fixtures: serde_json::Value =
            serde_json::from_str(&fixtures_text).expect("Invalid fixtures.json");
        let obj = fixtures
            .as_object()
            .expect("fixtures.json must be an object");

        for (name, cfg) in obj {
            let typst_mode = cfg
                .get("typst_mode")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let input_path = format!("../mmt_core/dsl_fixtures/{}", name);
            run_fixture(&input_path, typst_mode);
        }
    }
}
