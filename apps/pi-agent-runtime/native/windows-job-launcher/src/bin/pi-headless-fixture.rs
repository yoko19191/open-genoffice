use std::process::Command;
use std::thread;
use std::time::Duration;

fn blocks_for_cancel(args: &[String]) -> bool {
    args.iter().any(|value| value.contains("BLOCK_FOR_CANCEL"))
}

fn wait_forever() -> ! {
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--grandchild"] {
        wait_forever();
    }
    if blocks_for_cancel(&args) {
        let child = Command::new(std::env::current_exe().expect("fixture executable"))
            .arg("--grandchild")
            .spawn()
            .expect("fixture grandchild");
        std::fs::write("fixture-child.pid", child.id().to_string()).expect("fixture pid");
        wait_forever();
    }
    let message = r#"{"role":"assistant","content":[{"type":"text","text":"fixture child completed"}],"provider":"fixture-provider","model":"fixture-model","usage":{"input":7,"output":3,"cost":{"total":0.01}},"stopReason":"stop"}"#;
    println!(r#"{{"type":"message_end","message":{message}}}"#);
    println!(r#"{{"type":"agent_end","messages":[{message}]}}"#);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_the_explicit_cancel_fixture_prompt() {
        assert!(blocks_for_cancel(&["task BLOCK_FOR_CANCEL".to_owned()]));
        assert!(!blocks_for_cancel(&["ordinary task".to_owned()]));
    }
}
