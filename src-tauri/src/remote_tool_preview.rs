//! Bound tool details for mobile clients before serialization/compression.
//! Only the outgoing copy changes; runtime state, archives, chat text and desktop
//! clients retain the complete data. A binary-file diff can otherwise turn a
//! few hundred timeline rows into a 200 MiB snapshot and block heartbeats.
use serde_json::{json, Value};

const STRING_PREVIEW_BYTES: usize = 8 * 1024;
const TOOL_PREVIEW_BYTES: usize = 32 * 1024;
const MARKER: &str = "\n… [mobile preview] …\n";

pub(crate) fn requested(frame: &Value) -> bool {
    frame["toolPayloadPreview"] == 1
        || frame
            .pointer("/clientInfo/platform")
            .and_then(Value::as_str)
            .or_else(|| {
                frame
                    .pointer("/args/1/clientInfo/platform")
                    .and_then(Value::as_str)
            })
            .is_some_and(|platform| matches!(platform, "android" | "ios"))
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn preview(value: &mut Value, budget: &mut usize) -> bool {
    match value {
        Value::String(text) => {
            // Inline image previews must remain decodable. Bounding text must
            // not produce a broken data URL (including JSON-wrapped images).
            if text.contains("data:image/") {
                return false;
            }
            // Preserve short values such as file paths and status labels even
            // after the detail budget is exhausted.
            if text.len() <= 256 {
                return false;
            }
            let limit = STRING_PREVIEW_BYTES.min(*budget).max(MARKER.len());
            if text.len() <= limit {
                *budget = budget.saturating_sub(text.len());
                return false;
            }
            let available = limit - MARKER.len();
            let head = floor_boundary(text, available * 3 / 4);
            let mut tail = text.len() - available / 4;
            while !text.is_char_boundary(tail) {
                tail += 1;
            }
            *text = format!("{}{MARKER}{}", &text[..head], &text[tail..]);
            *budget = budget.saturating_sub(text.len());
            true
        }
        Value::Array(values) => values
            .iter_mut()
            .fold(false, |changed, value| preview(value, budget) || changed),
        Value::Object(values) => values
            .values_mut()
            .fold(false, |changed, value| preview(value, budget) || changed),
        _ => false,
    }
}

fn tool(value: &mut Value) {
    if !value.is_object() {
        return;
    }
    let mut budget = TOOL_PREVIEW_BYTES;
    let input = value
        .get_mut("input")
        .is_some_and(|value| preview(value, &mut budget));
    let result = value
        .get_mut("result")
        .is_some_and(|value| preview(value, &mut budget));
    if input || result {
        value["payloadPreview"] = json!({"input": input, "result": result});
    }
}

pub(crate) fn compact(value: &mut Value) {
    if matches!(
        value.get("channel").and_then(Value::as_str),
        Some(
            "agent:permission-request"
                | "claude:permission-request"
                | "agent:ask-user"
                | "claude:ask-user"
        )
    ) {
        return;
    }
    // Timeline tools in live state, archives and history. Do not descend into
    // their arbitrary payloads looking for event-shaped user data.
    if value.get("toolName").is_some() && value.get("input").is_some() {
        tool(value);
        return;
    }
    let field = match value.get("channel").and_then(Value::as_str) {
        Some("agent:tool-use" | "claude:tool-use") => Some("toolCall"),
        Some("agent:tool-result" | "claude:tool-result") => Some("result"),
        _ => None,
    };
    if let Some(field) = field {
        if let Some(record) = value
            .get_mut("params")
            .and_then(|params| params.get_mut(field))
        {
            tool(record);
        }
        if let Some(record) = value
            .get_mut("args")
            .and_then(Value::as_array_mut)
            .and_then(|args| args.get_mut(1))
        {
            tool(record);
        }
        return;
    }
    match value {
        Value::Array(values) => values.iter_mut().for_each(compact),
        Value::Object(values) => values
            .iter_mut()
            .filter(|(key, _)| !matches!(key.as_str(), "pendingPermission" | "pendingAskUser"))
            .for_each(|(_, value)| compact(value)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_snapshot_retains_every_row_and_source() {
        let source = json!({"type":"invoke-result", "result":{"mode":"snapshot", "cursor":{"epoch":"e","seq":7},
            "state":{"messages": [
                {"id":"t", "toolName":"Edit", "input":{"changes":[{"path":"image.b64", "diff":"a".repeat(2_000_000)}]}, "result":{"input":{"changes":[{"path":"image.b64", "diff":"b".repeat(2_000_000)}]}}},
                {"id":"m", "role":"assistant", "content":"完整對話"}
            ], "isStreaming":true, "streamingText":"串流", "pendingPermission":{"id":"permission"}}}});
        let mut frame = source.clone();
        compact(&mut frame);
        assert!(serde_json::to_vec(&frame).unwrap().len() < 20_000);
        assert_eq!(
            frame["result"]["state"]["messages"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            frame["result"]["state"]["messages"][0]["input"]["changes"][0]["path"],
            "image.b64"
        );
        assert_eq!(
            frame["result"]["state"]["messages"][0]["payloadPreview"],
            json!({"input":true,"result":true})
        );
        assert_eq!(
            frame["result"]["state"]["messages"][1],
            source["result"]["state"]["messages"][1]
        );
        assert_eq!(frame["result"]["cursor"], source["result"]["cursor"]);
        assert_eq!(
            source["result"]["state"]["messages"][0]["input"]["changes"][0]["diff"]
                .as_str()
                .unwrap()
                .len(),
            2_000_000
        );
    }

    #[test]
    fn live_and_replayed_results_are_bounded_with_legacy_args() {
        for channel in ["agent:tool-result", "claude:tool-result"] {
            let record = json!({"id":"t", "status":"completed", "result":"x".repeat(1_000_000)});
            let mut frame = json!({"type":"event", "channel":"agent:sync-event", "params":{"events":[
                {"seq":8,"channel":channel,"params":{"sessionId":"s","result":record},"args":["s",record]}
            ]}});
            compact(&mut frame);
            let event = &frame["params"]["events"][0];
            assert_eq!(event["params"]["result"], event["args"][1]);
            assert_eq!(event["params"]["result"]["payloadPreview"]["result"], true);
            assert!(
                event["params"]["result"]["result"].as_str().unwrap().len() <= STRING_PREVIEW_BYTES
            );
        }
    }

    #[test]
    fn history_and_tool_use_preserve_small_values_and_utf8() {
        let small = json!({"id":"t","toolName":"Edit","input":{"file_path":"original.txt","diff":"小修改"},"result":"ok"});
        let mut frame = json!({"channel":"agent:history", "params":{"items":[small]}});
        let before = frame.clone();
        compact(&mut frame);
        assert_eq!(frame, before);
        let mut large = json!({"channel":"agent:tool-use","params":{"toolCall":{"id":"t","toolName":"Edit","input":{"diff":"中文😀".repeat(20_000)}}}});
        compact(&mut large);
        let diff = large["params"]["toolCall"]["input"]["diff"]
            .as_str()
            .unwrap();
        assert!(diff.len() <= STRING_PREVIEW_BYTES);
        assert!(diff.starts_with("中文😀"));
        assert!(diff.ends_with("中文😀"));
    }

    #[test]
    fn total_detail_budget_handles_many_large_fields() {
        let mut frame = json!({"toolName":"Edit","input":{"changes":(0..100).map(|n| json!({"path":format!("{n}.txt"),"diff":"x".repeat(8_000)})).collect::<Vec<_>>()}});
        compact(&mut frame);
        assert!(serde_json::to_vec(&frame).unwrap().len() < 45_000);
        assert_eq!(frame["input"]["changes"].as_array().unwrap().len(), 100);
    }

    #[test]
    fn ordinary_chat_file_reads_and_approvals_are_not_truncated() {
        let text = "z".repeat(100_000);
        let mut frame = json!({"result":{"messages":[{"role":"user","content":text}],"content":text,"pendingPermission":{"toolName":"Bash","input":{"command":text}}}});
        let before = frame.clone();
        compact(&mut frame);
        assert_eq!(frame, before);
        let mut approval = json!({"channel":"agent:permission-request","params":{"request":{"toolName":"Bash","input":{"command":text}}}});
        let before = approval.clone();
        compact(&mut approval);
        assert_eq!(approval, before);
        let mut image = json!({"toolName":"image_gen","input":{"prompt":"image"},
            "result":serde_json::to_string(&json!({"dataUrl":format!("data:image/png;base64,{}", "A".repeat(20_000))})).unwrap()});
        let before = image.clone();
        compact(&mut image);
        assert_eq!(image, before);
    }

    #[test]
    fn mobile_or_explicit_opt_in_only() {
        assert!(requested(&json!({"toolPayloadPreview":1})));
        assert!(requested(
            &json!({"args":["phone",{"clientInfo":{"platform":"android"}}]})
        ));
        assert!(requested(&json!({"clientInfo":{"platform":"ios"}})));
        assert!(!requested(&json!({"clientInfo":{"platform":"windows"}})));
        assert!(!requested(&json!({})));
    }
}
